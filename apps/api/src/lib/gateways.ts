import { createHmac, timingSafeEqual } from 'node:crypto';

/** Razorpay Orders API + signature checks (https://razorpay.com/docs/api/orders/). */
export const razorpay = {
  base: 'https://api.razorpay.com/v1',
  auth: (keyId: string, secret: string) => 'Basic ' + Buffer.from(`${keyId}:${secret}`).toString('base64'),
  async createOrder(keyId: string, secret: string, body: { amount: number; currency: 'INR'; receipt: string; notes?: Record<string, string> }) {
    const r = await fetch(`${razorpay.base}/orders`, { method: 'POST', headers: { Authorization: razorpay.auth(keyId, secret), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(`Razorpay: ${j?.error?.description ?? r.statusText}`), { statusCode: 502 });
    return j as { id: string; amount: number; currency: string; status: string };
  },
  async test(keyId: string, secret: string) {
    const r = await fetch(`${razorpay.base}/orders?count=1`, { headers: { Authorization: razorpay.auth(keyId, secret) } });
    if (r.status === 401) return { ok: false, message: 'Razorpay rejected the key id / secret' };
    return r.ok ? { ok: true, message: 'Razorpay credentials accepted' } : { ok: false, message: `Razorpay returned ${r.status}` };
  },
  /** Checkout callback: HMAC_SHA256(order_id|payment_id, key_secret) */
  verifyPayment(orderId: string, paymentId: string, signature: string, secret: string) {
    return safeEq(createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex'), signature);
  },
  /** Webhook: X-Razorpay-Signature = HMAC_SHA256(raw body, webhook secret) */
  verifyWebhook(raw: string, signature: string, webhookSecret: string) {
    return safeEq(createHmac('sha256', webhookSecret).update(raw).digest('hex'), signature);
  },
};

/** Cashfree PG API v2023-08-01 (https://docs.cashfree.com/reference/pg-new-apis-endpoint). */
export const cashfree = {
  version: '2023-08-01',
  base: (env: string) => (env === 'production' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg'),
  headers: (appId: string, secret: string) => ({ 'x-client-id': appId, 'x-client-secret': secret, 'x-api-version': cashfree.version, 'Content-Type': 'application/json' }),
  async createOrder(env: string, appId: string, secret: string, body: {
    order_id: string; order_amount: number; order_currency: 'INR';
    customer_details: { customer_id: string; customer_phone: string; customer_name?: string; customer_email?: string };
    order_meta?: { return_url?: string; notify_url?: string }; order_note?: string;
  }) {
    const r = await fetch(`${cashfree.base(env)}/orders`, { method: 'POST', headers: cashfree.headers(appId, secret), body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(`Cashfree: ${j?.message ?? r.statusText}`), { statusCode: 502 });
    return j as { order_id: string; payment_session_id: string; order_status: string };
  },
  async getOrder(env: string, appId: string, secret: string, orderId: string) {
    const r = await fetch(`${cashfree.base(env)}/orders/${encodeURIComponent(orderId)}`, { headers: cashfree.headers(appId, secret) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(`Cashfree: ${j?.message ?? r.statusText}`), { statusCode: 502 });
    return j as { order_id: string; order_status: 'ACTIVE' | 'PAID' | 'EXPIRED' | 'TERMINATED'; order_amount: number; cf_order_id?: string };
  },
  async test(env: string, appId: string, secret: string) {
    const r = await fetch(`${cashfree.base(env)}/orders/onrmc-connection-test`, { headers: cashfree.headers(appId, secret) });
    if (r.status === 401 || r.status === 403) return { ok: false, message: 'Cashfree rejected the app id / secret key' };
    // 404 = authenticated, the test order just does not exist
    return r.status === 404 || r.ok ? { ok: true, message: `Cashfree ${env} credentials accepted` } : { ok: false, message: `Cashfree returned ${r.status}` };
  },
  /** Webhook: x-webhook-signature = base64(HMAC_SHA256(x-webhook-timestamp + raw body, secret)) */
  verifyWebhook(raw: string, timestamp: string, signature: string, secret: string) {
    return safeEq(createHmac('sha256', secret).update(timestamp + raw).digest('base64'), signature);
  },
};

function safeEq(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b ?? '');
  return x.length === y.length && timingSafeEqual(x, y);
}
