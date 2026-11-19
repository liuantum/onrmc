import { GspError, type GstinDetails } from './einvoice/adapters/types.js';
import { STATE_CODES } from './einvoice/validate.js';

/**
 * Cashfree Secure ID "Verify GSTIN": POST /verification/gstin with x-client-id / x-client-secret.
 * Prepaid, a few rupees per call; answers straight from the GST system, no captcha.
 * Sandbox: https://sandbox.cashfree.com · Production: https://api.cashfree.com
 */
const STATUS: Record<string, string> = { active: 'ACT', cancelled: 'CNL', suspended: 'SUS', inactive: 'INA', provisional: 'PRO' };
const stateCodeOf = (name: unknown, gstin: string) => {
  const n = String(name ?? '').toLowerCase().replace(/&/g, 'and').trim();
  return Object.entries(STATE_CODES).find(([, v]) => v.toLowerCase().replace(/&/g, 'and') === n)?.[0] ?? gstin.slice(0, 2);
};

export function parseCashfreeGstin(j: any, gstin: string): GstinDetails | null {
  if (!j || j.valid !== true) return null;
  const a = j.principal_place_split_address ?? {};
  const parts = [a.building_number, a.flat_number, a.building_name, a.street, a.location].map((x) => (x == null ? '' : String(x).trim())).filter(Boolean);
  const pin = a.pincode || /\b([1-9]\d{5})\b/.exec(String(j.principal_place_address ?? ''))?.[1];
  return {
    gstin: String(j.GSTIN ?? gstin).toUpperCase(), legalName: j.legal_name_of_business ?? null, tradeName: j.trade_name_of_business ?? null,
    address: parts.length ? parts.join(', ') : j.principal_place_address ?? null, city: a.city || a.district || null,
    stateCode: stateCodeOf(a.state, gstin), pincode: pin ? String(pin) : null,
    status: STATUS[String(j.gst_in_status ?? '').toLowerCase()] ?? (j.gst_in_status || null), taxpayerType: j.taxpayer_type ?? null, blocked: false,
  };
}

export async function cashfreeGstin(creds: { clientId: string; clientSecret: string }, env: 'sandbox' | 'production', gstin: string): Promise<GstinDetails | null> {
  const base = env === 'sandbox' ? 'https://sandbox.cashfree.com' : 'https://api.cashfree.com';
  let r: Response;
  try {
    r = await fetch(`${base}/verification/gstin`, {
      method: 'POST', signal: AbortSignal.timeout(20_000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-client-id': creds.clientId, 'x-client-secret': creds.clientSecret },
      body: JSON.stringify({ GSTIN: gstin }),
    });
  } catch (e) {
    throw new GspError(`Could not reach Cashfree (${(e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message}). Try again.`, 'NETWORK');
  }
  const j: any = await r.json().catch(() => null);
  if (r.ok) return parseCashfreeGstin(j, gstin);
  const code = j?.code ?? String(r.status);
  const msg = code === 'insufficient_balance' ? 'Cashfree verification balance is empty. Top it up in the Cashfree dashboard.'
    : r.status === 401 || code === 'authentication_failed' ? 'Cashfree rejected the client ID / secret (check you used the Verification keys for this environment)'
    : code === 'ip_validation_failed' ? "Cashfree blocked this server's IP. Whitelist it in the Cashfree dashboard."
    : j?.message ?? `Cashfree answered HTTP ${r.status}`;
  throw new GspError(msg, r.status === 401 || r.status === 403 ? 'AUTH' : code, j);
}
