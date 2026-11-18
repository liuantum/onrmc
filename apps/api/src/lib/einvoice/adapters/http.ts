import { GspError } from './types.js';

/** JSON request with a timeout; network failures and non-JSON answers become GspErrors. */
export async function gspFetch(url: string, init: { method: string; headers: Record<string, string>; body?: unknown }, timeoutMs = 30_000): Promise<{ status: number; json: any }> {
  let r: Response;
  try {
    r = await fetch(url, { method: init.method, headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...init.headers }, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new GspError(`Could not reach the provider (${(e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message}). Try again; if an IRN was created it will be fetched on retry.`, 'NETWORK');
  }
  const text = await r.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep null */ }
  if (r.status === 401 || r.status === 403) throw new GspError('The provider rejected the credentials (check token / username / password and the GSTIN it is linked to)', 'AUTH', json ?? text.slice(0, 500));
  if (json === null && !r.ok) throw new GspError(`Provider returned HTTP ${r.status}`, String(r.status), text.slice(0, 500));
  return { status: r.status, json };
}

/** Portal dates "dd/mm/yyyy hh:mm:ss" (IST) or ISO → Date. */
export function portalDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i.exec(s.trim());
  if (m) {
    let h = Number(m[4] ?? 0);
    if (m[7]) h = (h % 12) + (m[7].toUpperCase() === 'PM' ? 12 : 0);
    return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], h, Number(m[5] ?? 0), Number(m[6] ?? 0)) - 330 * 60e3);
  }
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? new Date(s.replace(' ', 'T') + '+05:30') : new Date(s);
  return isNaN(iso.getTime()) ? null : iso;
}

/** dd/mm/yyyy in IST for today. */
export const todayIst = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date());

export type GspEnv = 'sandbox' | 'production';
export const envOf = (creds: Record<string, string> | null): GspEnv => (creds?.environment === 'production' ? 'production' : 'sandbox');
