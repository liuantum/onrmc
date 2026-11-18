const KEY = 'onrmc.session';

export interface Session { token: string; user: { id: string; name: string; role: string; tenantId: string | null; tenantName?: string } }

export const session = {
  get(): Session | null { try { return JSON.parse(localStorage.getItem(KEY) ?? 'null'); } catch { return null; } },
  set(s: Session | null) { try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch { /* ignore */ } },
};

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const s = session.get();
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(s ? { Authorization: `Bearer ${s.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { session.set(null); location.href = '/login'; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.issues?.map((i: any) => `${i.path.join('.')}: ${i.message}`).join(', ') || data.error || res.statusText);
  return data as T;
}

export const money = (n: number | string) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(n));
export const qty = (n: number | string, d = 2) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: d });
export const date = (d: string | Date) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
export const dateTime = (d: string | Date) => new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
