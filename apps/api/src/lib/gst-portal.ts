import { randomBytes } from 'node:crypto';
import { GspError, type GstinDetails } from './einvoice/adapters/types.js';
import { STATE_CODES } from './einvoice/validate.js';

/**
 * Free GSTIN lookup through the GST portal's public "Search Taxpayer" page (services.gst.gov.in).
 * No account and no API key: the person using onrmc reads the portal's captcha and types it, exactly as
 * they would on the portal itself. onrmc only carries the request and fills the form with the answer.
 * The portal is not a published API, so if it changes this fails cleanly and the form stays editable.
 */
const BASE = 'https://services.gst.gov.in/services';
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; onrmc)', Accept: 'application/json, text/plain, */*', Referer: `${BASE}/searchtp`, Origin: 'https://services.gst.gov.in' };
const TTL = 5 * 60e3;
const sessions = new Map<string, { cookie: string; at: number }>();

function sweep() { const now = Date.now(); for (const [k, v] of sessions) if (now - v.at > TTL) sessions.delete(k); }

async function call(url: string, init: RequestInit) {
  try { return await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) }); } catch (e) {
    throw new GspError(`Could not reach the GST portal (${(e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message}). Try again, or fill the details by hand.`, 'NETWORK');
  }
}

/** A fresh captcha image (data URL) and a token that ties the answer to the portal session that issued it. */
export async function portalCaptcha() {
  sweep();
  const r = await call(`${BASE}/captcha?rnd=${Math.random()}`, { headers: HEADERS });
  if (!r.ok) throw new GspError(`The GST portal did not give a captcha (HTTP ${r.status}). Try again in a minute.`, String(r.status));
  const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const type = r.headers.get('content-type')?.split(';')[0] || 'image/png';
  const img = Buffer.from(await r.arrayBuffer()).toString('base64');
  const token = randomBytes(16).toString('hex');
  sessions.set(token, { cookie, at: Date.now() });
  return { token, image: `data:${type};base64,${img}` };
}

const STATUS: Record<string, string> = { active: 'ACT', cancelled: 'CNL', suspended: 'SUS', inactive: 'INA', provisional: 'PRO' };
const stateCodeOf = (name: unknown, gstin: string) => {
  const n = String(name ?? '').toLowerCase().replace(/&/g, 'and').replace(/\s+/g, ' ').trim();
  const hit = Object.entries(STATE_CODES).find(([, v]) => v.toLowerCase().replace(/&/g, 'and') === n);
  return hit?.[0] ?? gstin.slice(0, 2);
};

/** Portal answer → the same shape the GSP lookups return. */
export function parsePortalTaxpayer(j: any, gstin: string): GstinDetails | null {
  if (!j || typeof j !== 'object' || !(j.lgnm || j.tradeNam)) return null;
  const a = j.pradr?.addr ?? {};
  const parts = [a.bno, a.flno, a.bnm, a.st, a.locality, a.landMark].map((x) => (x == null ? '' : String(x).trim())).filter(Boolean);
  const address = parts.length ? parts.join(', ') : (typeof j.pradr?.adr === 'string' ? j.pradr.adr : null);
  const pin = a.pncd ?? /\b([1-9]\d{5})\b/.exec(String(j.pradr?.adr ?? ''))?.[1];
  return {
    gstin: String(j.gstin ?? gstin).toUpperCase(), legalName: j.lgnm ?? null, tradeName: j.tradeNam ?? null,
    address, city: a.loc || a.dst || null, stateCode: stateCodeOf(a.stcd, gstin), pincode: pin ? String(pin) : null,
    status: STATUS[String(j.sts ?? '').toLowerCase()] ?? (j.sts || null), taxpayerType: j.dty ?? j.ctb ?? null, blocked: false,
  };
}

/** Looks the GSTIN up with the captcha the person typed. Each captcha works once. */
export async function portalSearch(gstin: string, token: string, captcha: string): Promise<GstinDetails | null> {
  const s = sessions.get(token);
  sessions.delete(token);
  if (!s || Date.now() - s.at > TTL) throw new GspError('The captcha expired. Load a new one and try again.', 'CAPTCHA');
  const r = await call(`${BASE}/api/search/taxpayerDetails`, {
    method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/json', Cookie: s.cookie }, body: JSON.stringify({ gstin, captcha: captcha.trim() }),
  });
  const text = await r.text();
  let j: any = null;
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  const err = j?.errorCode ?? j?.error?.error_cd ?? j?.error?.errorCode;
  const msg = String(j?.message ?? j?.error?.message ?? '');
  if (err === 'SWEB_9000' || /captcha/i.test(msg) || /captcha/i.test(String(err ?? ''))) throw new GspError('The captcha did not match. Try the new one.', 'CAPTCHA');
  if (err === 'FO8000' || err === 'SWEB_9035' || /no records|not found|invalid gstin/i.test(msg)) return null;
  if (!r.ok || !j) throw new GspError(`The GST portal answered with ${r.status}${msg ? `: ${msg}` : ''}. Try again, or fill the details by hand.`, String(r.status));
  const d = parsePortalTaxpayer(j, gstin);
  if (!d && err) throw new GspError(`The GST portal said: ${msg || err}`, String(err));
  return d;
}
