import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireRole } from '../lib/auth.js';
import { SYSTEM_ACCOUNTS } from '../lib/ledger.js';
import { audit } from '../lib/audit.js';
import { bad, notFound } from '../lib/errors.js';
import { encryptJson } from '../lib/einvoice/crypto.js';
import { decryptJson } from '../lib/einvoice/crypto.js';
import { cashfree, razorpay } from '../lib/gateways.js';
import { activatePayment, clearStateCache, platformSettings, sweepSubscriptions } from '../lib/subscription.js';
import { gatewayMode } from './subscription.js';

const SECRET_FIELDS = ['razorpaySecretEnc', 'razorpayWebhookEnc', 'cashfreeSecretEnc', 'cashfreeWebhookEnc'] as const;
const enc = (v: string) => encryptJson({ v });
const dec = (v: string | null) => (v ? decryptJson<{ v: string }>(v).v : null);

/** Super admin: plans, tenants (plant owners), subscriptions. */
export default async function (app: FastifyInstance) {
  app.addHook('preHandler', requireRole('SUPER_ADMIN'));

  app.get('/stats', async () => {
    const [tenants, active, trial, mrr, pendingPayments] = await Promise.all([
      prisma.tenant.count(),
      prisma.subscription.count({ where: { status: 'ACTIVE', endsAt: { gt: new Date() } } }),
      prisma.subscription.count({ where: { status: 'TRIAL', endsAt: { gt: new Date() } } }),
      prisma.subscription.findMany({ where: { status: 'ACTIVE', endsAt: { gt: new Date() } }, include: { plan: true } }),
      prisma.subscriptionPayment.count({ where: { status: 'PENDING_VERIFICATION' } }),
    ]);
    const monthly = mrr.reduce((s, x) => s + Number(x.billingCycle === 'YEARLY' ? x.plan.priceYearly.div(12) : x.plan.priceMonthly), 0);
    return { tenants, active, trial, mrr: Math.round(monthly), pendingPayments };
  });

  const planSchema = z.object({
    name: z.string(), priceMonthly: z.number(), priceYearly: z.number(),
    maxPlants: z.number().int(), maxUsers: z.number().int(), maxVehicles: z.number().int(),
    features: z.array(z.string()).default([]), active: z.boolean().default(true),
  });
  app.get('/plans', async () => prisma.plan.findMany({ orderBy: { priceMonthly: 'asc' } }));
  app.post('/plans', async (req) => prisma.plan.create({ data: planSchema.parse(req.body) }));
  app.put('/plans/:id', async (req) => prisma.plan.update({ where: { id: (req.params as { id: string }).id }, data: planSchema.partial().parse(req.body) }));

  app.get('/tenants', async () =>
    prisma.tenant.findMany({
      orderBy: { createdAt: 'desc' },
      include: { subscriptions: { orderBy: { endsAt: 'desc' }, take: 1, include: { plan: true } }, _count: { select: { users: true, plants: true, vehicles: true } } },
    }));

  /** Onboard a plant owner: tenant + owner login + default plant + chart of accounts + subscription. */
  app.post('/tenants', async (req) => {
    const b = z.object({
      name: z.string(), gstin: z.string().optional(), stateCode: z.string().length(2),
      ownerName: z.string(), ownerPhone: z.string(), ownerPassword: z.string().min(8),
      planId: z.string(), trialDays: z.number().int().default(14),
    }).parse(req.body);
    const tenant = await prisma.$transaction(async (tx) => {
      const t = await tx.tenant.create({ data: { name: b.name, gstin: b.gstin, stateCode: b.stateCode } });
      await tx.user.create({ data: { tenantId: t.id, name: b.ownerName, phone: b.ownerPhone, role: 'OWNER', passwordHash: await bcrypt.hash(b.ownerPassword, 10) } });
      await tx.plant.create({ data: { tenantId: t.id, name: 'Main Plant' } });
      await tx.account.createMany({ data: SYSTEM_ACCOUNTS.map((a) => ({ ...a, tenantId: t.id, system: true })) });
      await tx.subscription.create({ data: { tenantId: t.id, planId: b.planId, status: 'TRIAL', endsAt: new Date(Date.now() + b.trialDays * 864e5) } });
      return t;
    });
    await audit(req, 'CREATE', 'Tenant', tenant.id, { name: b.name });
    return tenant;
  });

  app.post('/tenants/:id/subscription', async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ planId: z.string(), status: z.enum(['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED']), billingCycle: z.enum(['MONTHLY', 'YEARLY']), months: z.number().int().min(0) }).parse(req.body);
    const endsAt = new Date(); endsAt.setMonth(endsAt.getMonth() + b.months);
    const sub = await prisma.subscription.create({ data: { tenantId: id, planId: b.planId, status: b.status, billingCycle: b.billingCycle, endsAt } });
    clearStateCache(id);
    await audit(req, 'SUBSCRIPTION', 'Tenant', id, b);
    return sub;
  });

  app.post('/tenants/:id/active', async (req) => {
    const { id } = req.params as { id: string };
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    clearStateCache(id);
    await audit(req, active ? 'TENANT_REACTIVATED' : 'TENANT_SUSPENDED', 'Tenant', id);
    return prisma.tenant.update({ where: { id }, data: { active } });
  });

  // ───── Payment settings (secrets are write-only) ─────
  const view = async () => {
    const ps = await platformSettings();
    const out: Record<string, unknown> = { ...ps };
    for (const f of SECRET_FIELDS) { out[f.replace(/Enc$/, 'Saved')] = !!ps[f]; delete out[f]; }
    return { ...out, razorpayMode: gatewayMode.razorpay(ps.razorpayKeyId), cashfreeMode: gatewayMode.cashfree(ps.cashfreeEnv), encryptionReady: (process.env.EINVOICE_ENC_KEY?.length ?? 0) >= 16 };
  };
  app.get('/platform-settings', view);

  app.put('/platform-settings', { bodyLimit: 2 * 1024 * 1024 }, async (req) => {
    const opt = z.string().trim().max(200).nullish().transform((v) => v || null);
    const b = z.object({
      manualEnabled: z.boolean(), upiId: z.string().trim().regex(/^[\w.-]{2,256}@[a-zA-Z][a-zA-Z0-9.]{1,63}$/, 'UPI ID looks wrong (like name@okhdfcbank)').nullish().or(z.literal('').transform(() => null)), upiQr: z.string().startsWith('data:image/').max(1_500_000).nullish(),
      bankAccountName: opt, bankAccountNo: opt, bankIfsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC looks wrong').nullish().or(z.literal('').transform(() => null)),
      bankName: opt, bankBranch: opt, instructions: z.string().max(1000).nullish(),
      razorpayEnabled: z.boolean(), razorpayKeyId: z.string().trim().regex(/^rzp_(test|live)_\w+$/, 'Razorpay key id starts with rzp_test_ or rzp_live_').nullish().or(z.literal('').transform(() => null)),
      cashfreeEnabled: z.boolean(), cashfreeEnv: z.enum(['sandbox', 'production']), cashfreeAppId: opt,
      sellerLegalName: z.string().min(2), sellerGstin: opt, sellerStateCode: z.string().length(2), sellerAddress: opt, sellerPincode: z.string().regex(/^\d{6}$/).nullish().or(z.literal('').transform(() => null)),
      sacCode: z.string().regex(/^\d{6}$/), gstRate: z.number().min(0).max(28), graceDays: z.number().int().min(0).max(60), reminderDays: z.number().int().min(0).max(60),
      /** new secret values; empty or missing keeps the stored one */
      secrets: z.object({ razorpaySecret: z.string(), razorpayWebhook: z.string(), cashfreeSecret: z.string(), cashfreeWebhook: z.string() }).partial().optional(),
    }).parse(req.body);
    const { secrets, ...data } = b;
    const upd: Record<string, unknown> = { ...data };
    if (b.upiQr === undefined) delete upd.upiQr;
    try {
      for (const [k, v] of Object.entries(secrets ?? {})) if (v?.trim()) upd[`${k}Enc`] = enc(v.trim());
    } catch (e) { throw bad((e as Error).message); }
    const cur = await platformSettings();
    const has = (k: (typeof SECRET_FIELDS)[number]) => !!(upd[k] ?? cur[k]);
    if (b.razorpayEnabled && (!b.razorpayKeyId || !has('razorpaySecretEnc'))) throw bad('Add the Razorpay key id and secret before switching Razorpay on');
    if (b.cashfreeEnabled && (!b.cashfreeAppId || !has('cashfreeSecretEnc'))) throw bad('Add the Cashfree app id and secret key before switching Cashfree on');
    if (b.manualEnabled && !(b.upiId || (b.upiQr ?? cur.upiQr) || b.bankAccountNo)) throw bad('Manual payment needs a UPI id, QR code or bank account');
    await prisma.platformSettings.update({ where: { id: 'platform' }, data: upd });
    await audit(req, 'PLATFORM_SETTINGS', 'PlatformSettings', 'platform', { ...data, upiQr: data.upiQr ? '(image)' : data.upiQr, secretsChanged: Object.keys(secrets ?? {}).filter((k) => secrets?.[k as keyof typeof secrets]?.trim()) });
    return view();
  });

  app.post('/platform-settings/test/:provider', async (req) => {
    const { provider } = req.params as { provider: string };
    const ps = await platformSettings();
    if (provider === 'razorpay') {
      const s = dec(ps.razorpaySecretEnc);
      if (!ps.razorpayKeyId || !s) throw bad('Save the Razorpay key id and secret first');
      return razorpay.test(ps.razorpayKeyId, s);
    }
    if (provider === 'cashfree') {
      const s = dec(ps.cashfreeSecretEnc);
      if (!ps.cashfreeAppId || !s) throw bad('Save the Cashfree app id and secret first');
      return cashfree.test(ps.cashfreeEnv, ps.cashfreeAppId, s);
    }
    throw notFound();
  });

  // ───── Subscription payments ─────
  app.get('/subscription-payments', async (req) => {
    const { status } = req.query as { status?: string };
    return prisma.subscriptionPayment.findMany({
      where: status ? { status: status as never } : {}, orderBy: { createdAt: 'desc' }, take: 200,
      select: { id: true, createdAt: true, method: true, status: true, billingCycle: true, months: true, taxable: true, cgst: true, sgst: true, igst: true, total: true, reference: true, paidOn: true, rejectReason: true, gatewayOrderId: true, gatewayPaymentId: true, verifiedAt: true,
        screenshot: status === 'PENDING_VERIFICATION', tenant: { select: { id: true, name: true, gstin: true } }, plan: { select: { name: true } }, invoice: { select: { id: true, number: true } } },
    });
  });

  app.post('/subscription-payments/:id/approve', async (req) => {
    const { id } = req.params as { id: string };
    const p = await prisma.subscriptionPayment.findUnique({ where: { id } });
    if (!p) throw notFound();
    if (p.method !== 'MANUAL' || p.status !== 'PENDING_VERIFICATION') throw bad('Only manual payments waiting for verification can be approved');
    const r = await activatePayment(id, { verifiedById: req.user.sub });
    await audit(req, 'SUBSCRIPTION_PAYMENT_APPROVED', 'SubscriptionPayment', id, { tenantId: p.tenantId, reference: p.reference, total: p.total });
    return r;
  });

  app.post('/subscription-payments/:id/reject', async (req) => {
    const { id } = req.params as { id: string };
    const { reason } = z.object({ reason: z.string().trim().min(3) }).parse(req.body);
    const r = await prisma.subscriptionPayment.updateMany({ where: { id, status: 'PENDING_VERIFICATION' }, data: { status: 'REJECTED', rejectReason: reason, verifiedById: req.user.sub, verifiedAt: new Date() } });
    if (!r.count) throw bad('Only payments waiting for verification can be rejected');
    await audit(req, 'SUBSCRIPTION_PAYMENT_REJECTED', 'SubscriptionPayment', id, { reason });
    return { ok: true };
  });

  /** Runs the lapse sweep now (it also runs hourly). */
  app.post('/subscriptions/sweep', async () => ({ changed: await sweepSubscriptions() }));
}
