import { computeLine, fyLabel } from '@onrmc/shared';
import { prisma, num, type Tx } from './prisma.js';

export type SubState = 'TRIAL' | 'ACTIVE' | 'GRACE' | 'PAUSED';
const DAY = 864e5;

export async function platformSettings(tx: Tx = prisma) {
  return tx.platformSettings.upsert({ where: { id: 'platform' }, create: { id: 'platform' }, update: {} });
}

export async function latestSubscription(tenantId: string, tx: Tx = prisma) {
  return tx.subscription.findFirst({ where: { tenantId }, orderBy: { endsAt: 'desc' }, include: { plan: true } });
}

/**
 * trial / active → (expiry) → grace (writes still allowed, banner) → paused (read-only; login and the
 * subscription page still work). A subscription the super admin marks SUSPENDED/CANCELLED is paused at once.
 */
export async function subscriptionState(tenantId: string) {
  const [sub, ps] = await Promise.all([latestSubscription(tenantId), platformSettings()]);
  const now = Date.now();
  if (!sub) return { state: 'PAUSED' as SubState, plan: null, endsAt: null, graceUntil: null, daysLeft: 0, reminder: true, message: 'No subscription — choose a plan to continue.' };
  const ends = sub.endsAt.getTime(), graceUntil = new Date(ends + ps.graceDays * DAY);
  const daysLeft = Math.ceil((ends - now) / DAY);
  let state: SubState;
  if (sub.status === 'SUSPENDED' || sub.status === 'CANCELLED') state = 'PAUSED';
  else if (now < ends) state = sub.status === 'TRIAL' ? 'TRIAL' : 'ACTIVE';
  else if (now < graceUntil.getTime()) state = 'GRACE';
  else state = 'PAUSED';
  const reminder = state === 'GRACE' || state === 'PAUSED' || daysLeft <= ps.reminderDays;
  const message =
    state === 'PAUSED' ? 'Your subscription has lapsed. The account is read-only until you renew.'
    : state === 'GRACE' ? `Your subscription expired on ${sub.endsAt.toDateString()}. Renew by ${graceUntil.toDateString()} to avoid read-only mode.`
    : reminder ? `Your ${state === 'TRIAL' ? 'trial' : 'subscription'} ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.` : null;
  return { state, plan: { id: sub.plan.id, name: sub.plan.name }, status: sub.status, billingCycle: sub.billingCycle, endsAt: sub.endsAt, graceUntil, daysLeft, reminder, message };
}

const cache = new Map<string, { at: number; state: SubState }>();
/** Cached (30 s) state for the write guard. */
export async function cachedState(tenantId: string) {
  const c = cache.get(tenantId);
  if (c && Date.now() - c.at < 30_000) return c.state;
  const s = (await subscriptionState(tenantId)).state;
  cache.set(tenantId, { at: Date.now(), state: s });
  return s;
}
export const clearStateCache = (tenantId: string) => cache.delete(tenantId);

/** Server-side price for a plan and cycle, GST by place of supply (owner's state vs onrmc's). */
export async function quote(tenantId: string, planId: string, cycle: 'MONTHLY' | 'YEARLY', tx: Tx = prisma) {
  const [plan, tenant, ps] = await Promise.all([tx.plan.findUnique({ where: { id: planId } }), tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }), platformSettings(tx)]);
  if (!plan || !plan.active) throw Object.assign(new Error('Plan not available'), { statusCode: 400 });
  const price = num(cycle === 'YEARLY' ? plan.priceYearly : plan.priceMonthly);
  const interState = tenant.stateCode !== ps.sellerStateCode;
  const tb = computeLine({ quantity: 1, rate: price, gstRate: num(ps.gstRate) }, interState, true);
  return { plan, months: cycle === 'YEARLY' ? 12 : 1, interState, taxable: tb.taxable, cgst: tb.cgst, sgst: tb.sgst, igst: tb.igst, total: tb.total, gstRate: num(ps.gstRate) };
}

async function nextPlatformNumber(tx: Tx, prefix: string) {
  const key = `${prefix}/${fyLabel(new Date())}`;
  const s = await tx.platformSeries.upsert({ where: { key }, create: { key, next: 2 }, update: { next: { increment: 1 } } });
  return `${key}/${String(s.next - 1).padStart(4, '0')}`;
}

/**
 * Marks a payment PAID exactly once, extends the subscription and issues onrmc's GST invoice.
 * Safe to call repeatedly (gateway callback + webhook): only the first call does anything.
 */
export async function activatePayment(paymentId: string, extra: { gatewayPaymentId?: string; raw?: unknown; verifiedById?: string } = {}) {
  const done = await prisma.$transaction(async (tx) => {
    const r = await tx.subscriptionPayment.updateMany({
      where: { id: paymentId, status: { in: ['CREATED', 'PENDING_VERIFICATION', 'FAILED'] } },
      data: { status: 'PAID', paidOn: new Date(), ...(extra.gatewayPaymentId ? { gatewayPaymentId: extra.gatewayPaymentId } : {}), ...(extra.raw ? { raw: extra.raw as object } : {}), ...(extra.verifiedById ? { verifiedById: extra.verifiedById, verifiedAt: new Date() } : {}) },
    });
    if (!r.count) return null; // already processed (or rejected)
    const p = await tx.subscriptionPayment.findUniqueOrThrow({ where: { id: paymentId }, include: { plan: true, tenant: true } });
    const cur = await latestSubscription(p.tenantId, tx);
    const now = new Date();
    // renewals continue from the current expiry; a lapsed or suspended account starts today
    const base = cur && cur.endsAt > now && !['SUSPENDED', 'CANCELLED'].includes(cur.status) ? cur.endsAt : now;
    const endsAt = new Date(base); endsAt.setMonth(endsAt.getMonth() + p.months);
    await tx.subscription.create({ data: { tenantId: p.tenantId, planId: p.planId, status: 'ACTIVE', billingCycle: p.billingCycle, startsAt: now, endsAt } });
    const ps = await platformSettings(tx);
    await tx.subscriptionInvoice.create({ data: {
      number: await nextPlatformNumber(tx, 'SUB'), paymentId: p.id, tenantId: p.tenantId,
      seller: { legalName: ps.sellerLegalName, gstin: ps.sellerGstin, stateCode: ps.sellerStateCode, address: ps.sellerAddress, pincode: ps.sellerPincode },
      buyerName: p.tenant.legalName ?? p.tenant.name, buyerGstin: p.tenant.gstin, buyerStateCode: p.tenant.stateCode, buyerAddress: [p.tenant.address, p.tenant.city, p.tenant.pincode].filter(Boolean).join(', ') || null,
      placeOfSupply: p.tenant.stateCode, interState: num(p.igst) > 0,
      description: `onrmc ${p.plan.name} plan — ${p.billingCycle === 'YEARLY' ? '12 months' : '1 month'} (${base.toDateString()} to ${endsAt.toDateString()})`,
      sac: ps.sacCode, gstRate: ps.gstRate, taxable: p.taxable, cgst: p.cgst, sgst: p.sgst, igst: p.igst, total: p.total,
    } });
    return { tenantId: p.tenantId, endsAt };
  });
  if (done) clearStateCache(done.tenantId);
  return done;
}

/** Hourly: record lapsed subscriptions (TRIAL/ACTIVE → PAST_DUE in grace → SUSPENDED after grace). */
export async function sweepSubscriptions() {
  const ps = await platformSettings();
  const now = new Date();
  const tenants = await prisma.tenant.findMany({ select: { id: true } });
  let changed = 0;
  for (const t of tenants) {
    const s = await latestSubscription(t.id);
    if (!s || ['SUSPENDED', 'CANCELLED'].includes(s.status) || s.endsAt > now) continue;
    const next = now.getTime() > s.endsAt.getTime() + ps.graceDays * DAY ? 'SUSPENDED' : 'PAST_DUE';
    if (s.status !== next) { await prisma.subscription.update({ where: { id: s.id }, data: { status: next } }); clearStateCache(t.id); changed++; }
  }
  return changed;
}
