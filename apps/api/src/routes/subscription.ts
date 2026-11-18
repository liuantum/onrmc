import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, num } from '../lib/prisma.js';
import { authenticate, requireRole, tid } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { bad, HttpError, notFound } from '../lib/errors.js';
import { decryptJson } from '../lib/einvoice/crypto.js';
import { cashfree, razorpay } from '../lib/gateways.js';
import { activatePayment, platformSettings, quote, subscriptionState } from '../lib/subscription.js';

const cycle = z.enum(['MONTHLY', 'YEARLY']);
const secret = (enc: string | null) => (enc ? decryptJson<{ v: string }>(enc).v : null);
export const gatewayMode = {
  razorpay: (keyId: string | null) => (keyId?.startsWith('rzp_live_') ? 'live' : 'test'),
  cashfree: (env: string) => (env === 'production' ? 'live' : 'test'),
};

/** What an owner sees and does to pay onrmc. Paths stay open while the account is paused. */
export default async function (app: FastifyInstance) {
  const owner = { preHandler: requireRole('OWNER') };

  /** Any signed-in tenant user: current state for the banner; owners also get plans and payment options. */
  app.get('/status', { preHandler: authenticate }, async (req) => {
    if (!req.user.tenantId) return { state: 'ACTIVE', message: null };
    const t = tid(req);
    const state = await subscriptionState(t);
    if (req.user.role !== 'OWNER') return state;
    const ps = await platformSettings();
    const plans = await prisma.plan.findMany({ where: { active: true }, orderBy: { priceMonthly: 'asc' } });
    const quotes = await Promise.all(plans.flatMap((p) => (['MONTHLY', 'YEARLY'] as const).map(async (c) => ({ planId: p.id, cycle: c, ...(await quote(t, p.id, c)), plan: undefined }))));
    return {
      ...state, plans, quotes,
      methods: {
        manual: ps.manualEnabled ? { upiId: ps.upiId, upiQr: ps.upiQr, bankAccountName: ps.bankAccountName, bankAccountNo: ps.bankAccountNo, bankIfsc: ps.bankIfsc, bankName: ps.bankName, bankBranch: ps.bankBranch, instructions: ps.instructions } : null,
        razorpay: ps.razorpayEnabled && ps.razorpayKeyId && ps.razorpaySecretEnc ? { mode: gatewayMode.razorpay(ps.razorpayKeyId) } : null,
        cashfree: ps.cashfreeEnabled && ps.cashfreeAppId && ps.cashfreeSecretEnc ? { mode: gatewayMode.cashfree(ps.cashfreeEnv), env: ps.cashfreeEnv } : null,
      },
    };
  });

  app.get('/payments', owner, async (req) =>
    prisma.subscriptionPayment.findMany({ where: { tenantId: tid(req) }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, createdAt: true, method: true, status: true, billingCycle: true, total: true, reference: true, rejectReason: true, plan: { select: { name: true } }, invoice: { select: { id: true, number: true } } } }));

  app.get('/invoices/:id', { preHandler: authenticate }, async (req) => {
    const { id } = req.params as { id: string };
    const inv = await prisma.subscriptionInvoice.findUnique({ where: { id }, include: { payment: { select: { method: true, reference: true, gatewayPaymentId: true, paidOn: true } } } });
    if (!inv || (req.user.role !== 'SUPER_ADMIN' && (req.user.role !== 'OWNER' || inv.tenantId !== req.user.tenantId))) throw notFound('Invoice not found');
    return inv;
  });

  // ───── Manual: UPI / bank transfer, approved by super admin ─────
  app.post('/manual', { ...owner, bodyLimit: 4 * 1024 * 1024 }, async (req) => {
    const b = z.object({
      planId: z.string(), cycle,
      reference: z.string().trim().min(6, 'Enter the UTR / transaction reference').max(40),
      paidOn: z.coerce.date(),
      screenshot: z.string().startsWith('data:image/').max(3_000_000).optional(),
    }).parse(req.body);
    const ps = await platformSettings();
    if (!ps.manualEnabled) throw bad('Manual payment is switched off. Choose another method.');
    if (b.paidOn.getTime() > Date.now() + 864e5) throw bad('Payment date cannot be in the future');
    const t = tid(req);
    const dup = await prisma.subscriptionPayment.findFirst({ where: { reference: b.reference, method: 'MANUAL', status: { in: ['PENDING_VERIFICATION', 'PAID'] } } });
    if (dup) throw bad('This UTR has already been submitted');
    const q = await quote(t, b.planId, b.cycle);
    const p = await prisma.subscriptionPayment.create({ data: {
      tenantId: t, planId: b.planId, billingCycle: b.cycle, months: q.months, taxable: q.taxable, cgst: q.cgst, sgst: q.sgst, igst: q.igst, total: q.total,
      method: 'MANUAL', status: 'PENDING_VERIFICATION', reference: b.reference, paidOn: b.paidOn, screenshot: b.screenshot, submittedById: req.user.sub,
    } });
    await audit(req, 'SUBSCRIPTION_PAYMENT_SUBMITTED', 'SubscriptionPayment', p.id, { method: 'MANUAL', reference: b.reference, total: q.total });
    return { id: p.id, status: p.status, total: q.total };
  });

  // ───── Razorpay Checkout ─────
  app.post('/razorpay/order', owner, async (req) => {
    const b = z.object({ planId: z.string(), cycle }).parse(req.body);
    const ps = await platformSettings();
    const key = secret(ps.razorpaySecretEnc);
    if (!ps.razorpayEnabled || !ps.razorpayKeyId || !key) throw bad('Razorpay is not available');
    const t = tid(req);
    const q = await quote(t, b.planId, b.cycle);
    const p = await prisma.subscriptionPayment.create({ data: {
      tenantId: t, planId: b.planId, billingCycle: b.cycle, months: q.months, taxable: q.taxable, cgst: q.cgst, sgst: q.sgst, igst: q.igst, total: q.total,
      method: 'RAZORPAY', status: 'CREATED', submittedById: req.user.sub,
    } });
    const order = await razorpay.createOrder(ps.razorpayKeyId, key, { amount: Math.round(q.total * 100), currency: 'INR', receipt: p.id, notes: { tenantId: t, paymentId: p.id } });
    await prisma.subscriptionPayment.update({ where: { id: p.id }, data: { gatewayOrderId: order.id } });
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: t } });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user.sub } });
    return { paymentId: p.id, keyId: ps.razorpayKeyId, orderId: order.id, amount: order.amount, currency: 'INR', name: 'onrmc', description: `${q.plan.name} · ${b.cycle.toLowerCase()}`, prefill: { name: user.name, contact: user.phone, email: user.email ?? tenant.email ?? undefined }, mode: gatewayMode.razorpay(ps.razorpayKeyId) };
  });

  app.post('/razorpay/verify', owner, async (req) => {
    const b = z.object({ paymentId: z.string(), razorpay_order_id: z.string(), razorpay_payment_id: z.string(), razorpay_signature: z.string() }).parse(req.body);
    const p = await prisma.subscriptionPayment.findFirst({ where: { id: b.paymentId, tenantId: tid(req), method: 'RAZORPAY' } });
    if (!p || p.gatewayOrderId !== b.razorpay_order_id) throw notFound('Payment not found');
    const key = secret((await platformSettings()).razorpaySecretEnc);
    if (!key || !razorpay.verifyPayment(b.razorpay_order_id, b.razorpay_payment_id, b.razorpay_signature, key)) {
      await prisma.subscriptionPayment.updateMany({ where: { id: p.id, status: 'CREATED' }, data: { status: 'FAILED', rejectReason: 'Signature check failed' } });
      throw new HttpError(400, 'Payment could not be verified');
    }
    await activatePayment(p.id, { gatewayPaymentId: b.razorpay_payment_id, raw: { via: 'checkout', ...b } });
    await audit(req, 'SUBSCRIPTION_PAID', 'SubscriptionPayment', p.id, { method: 'RAZORPAY', paymentId: b.razorpay_payment_id });
    return subscriptionState(tid(req));
  });

  // ───── Cashfree Checkout ─────
  app.post('/cashfree/order', owner, async (req) => {
    const b = z.object({ planId: z.string(), cycle, returnUrl: z.string().url().optional() }).parse(req.body);
    const ps = await platformSettings();
    const key = secret(ps.cashfreeSecretEnc);
    if (!ps.cashfreeEnabled || !ps.cashfreeAppId || !key) throw bad('Cashfree is not available');
    const t = tid(req);
    const q = await quote(t, b.planId, b.cycle);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user.sub } });
    const p = await prisma.subscriptionPayment.create({ data: {
      tenantId: t, planId: b.planId, billingCycle: b.cycle, months: q.months, taxable: q.taxable, cgst: q.cgst, sgst: q.sgst, igst: q.igst, total: q.total,
      method: 'CASHFREE', status: 'CREATED', submittedById: req.user.sub,
    } });
    const orderId = `onrmc_${p.id}`;
    const order = await cashfree.createOrder(ps.cashfreeEnv, ps.cashfreeAppId, key, {
      order_id: orderId, order_amount: q.total, order_currency: 'INR',
      customer_details: { customer_id: t, customer_phone: user.phone, customer_name: user.name, customer_email: user.email ?? undefined },
      order_meta: b.returnUrl ? { return_url: `${b.returnUrl}${b.returnUrl.includes('?') ? '&' : '?'}cf=${p.id}` } : undefined,
      order_note: `${q.plan.name} ${b.cycle}`,
    });
    await prisma.subscriptionPayment.update({ where: { id: p.id }, data: { gatewayOrderId: orderId } });
    return { paymentId: p.id, paymentSessionId: order.payment_session_id, env: ps.cashfreeEnv, mode: gatewayMode.cashfree(ps.cashfreeEnv) };
  });

  /** Called after the Cashfree checkout closes: asks Cashfree for the order status (never trusts the browser). */
  app.post('/cashfree/verify', owner, async (req) => {
    const { paymentId } = z.object({ paymentId: z.string() }).parse(req.body);
    const p = await prisma.subscriptionPayment.findFirst({ where: { id: paymentId, tenantId: tid(req), method: 'CASHFREE' } });
    if (!p?.gatewayOrderId) throw notFound('Payment not found');
    await confirmCashfreeOrder(p.gatewayOrderId);
    const after = await prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: p.id } });
    if (after.status !== 'PAID') throw new HttpError(402, 'Cashfree has not confirmed this payment yet. If money was debited it will activate automatically within a few minutes.');
    await audit(req, 'SUBSCRIPTION_PAID', 'SubscriptionPayment', p.id, { method: 'CASHFREE' });
    return subscriptionState(tid(req));
  });
}

/** Fetches the order from Cashfree and activates when it is PAID for the full amount. */
export async function confirmCashfreeOrder(orderId: string) {
  const p = await prisma.subscriptionPayment.findUnique({ where: { gatewayOrderId: orderId } });
  if (!p) return null;
  const ps = await platformSettings();
  const key = secret(ps.cashfreeSecretEnc);
  if (!ps.cashfreeAppId || !key) return null;
  const o = await cashfree.getOrder(ps.cashfreeEnv, ps.cashfreeAppId, key, orderId);
  if (o.order_status === 'PAID' && Math.abs(o.order_amount - num(p.total)) < 0.01) return activatePayment(p.id, { gatewayPaymentId: o.cf_order_id, raw: o });
  return null;
}

/** Gateway webhooks: raw body for signature checks, deduplicated by event id. No login. */
export async function webhookRoutes(app: FastifyInstance) {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
  const once = async (provider: string, eventId: string) => {
    try { await prisma.webhookEvent.create({ data: { provider, eventId } }); return true; } catch { return false; }
  };

  app.post('/razorpay', async (req, reply) => {
    const raw = String(req.body ?? '');
    const ps = await platformSettings();
    const wh = secret(ps.razorpayWebhookEnc);
    if (!wh || !razorpay.verifyWebhook(raw, String(req.headers['x-razorpay-signature'] ?? ''), wh)) return reply.code(401).send({ error: 'bad signature' });
    const ev = JSON.parse(raw);
    const eventId = String(req.headers['x-razorpay-event-id'] ?? `${ev.event}:${ev.payload?.payment?.entity?.id ?? ev.created_at}`);
    if (!(await once('RAZORPAY', eventId))) return { ok: true, duplicate: true };
    const pay = ev.payload?.payment?.entity;
    if ((ev.event === 'payment.captured' || ev.event === 'order.paid') && pay?.order_id) {
      const p = await prisma.subscriptionPayment.findUnique({ where: { gatewayOrderId: pay.order_id } });
      if (p && Math.round(num(p.total) * 100) === pay.amount) await activatePayment(p.id, { gatewayPaymentId: pay.id, raw: { via: 'webhook', event: ev.event } });
    } else if (ev.event === 'payment.failed' && pay?.order_id) {
      await prisma.subscriptionPayment.updateMany({ where: { gatewayOrderId: pay.order_id, status: 'CREATED' }, data: { status: 'FAILED', rejectReason: pay.error_description ?? 'Payment failed' } });
    }
    return { ok: true };
  });

  app.post('/cashfree', async (req, reply) => {
    const raw = String(req.body ?? '');
    const ps = await platformSettings();
    const wh = secret(ps.cashfreeWebhookEnc) ?? secret(ps.cashfreeSecretEnc);
    const ts = String(req.headers['x-webhook-timestamp'] ?? '');
    if (!wh || !cashfree.verifyWebhook(raw, ts, String(req.headers['x-webhook-signature'] ?? ''), wh)) return reply.code(401).send({ error: 'bad signature' });
    const ev = JSON.parse(raw);
    const orderId = ev.data?.order?.order_id;
    if (!(await once('CASHFREE', `${ev.type}:${orderId}:${ev.data?.payment?.cf_payment_id ?? ts}`))) return { ok: true, duplicate: true };
    if (ev.type === 'PAYMENT_SUCCESS_WEBHOOK' && orderId) await confirmCashfreeOrder(orderId); // re-check with Cashfree before activating
    else if (ev.type === 'PAYMENT_FAILED_WEBHOOK' && orderId)
      await prisma.subscriptionPayment.updateMany({ where: { gatewayOrderId: orderId, status: 'CREATED' }, data: { status: 'FAILED', rejectReason: ev.data?.payment?.payment_message ?? 'Payment failed' } });
    return { ok: true };
  });
}
