import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, session } from '../lib/api';

export default function Login() {
  const nav = useNavigate();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setErr(null);
    try {
      const s = await api('/auth/login', { body: { phone: f.get('phone'), password: f.get('password') } });
      session.set(s); nav('/');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-900 to-brand-600 p-4">
      <form onSubmit={submit} className="card w-full max-w-sm p-8">
        <div className="text-3xl font-bold tracking-tight text-brand-700">onrmc</div>
        <p className="mb-6 mt-1 text-sm text-slate-500">Ready-mix concrete, run properly.</p>
        <label className="label" htmlFor="phone">Mobile number</label>
        <input id="phone" name="phone" className="input mb-4" inputMode="tel" autoComplete="username" required />
        <label className="label" htmlFor="password">Password</label>
        <input id="password" name="password" type="password" className="input mb-6" autoComplete="current-password" required />
        <button className="btn-primary w-full justify-center py-2.5" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        {err && <p className="mt-4 text-sm text-red-600">{err}</p>}
      </form>
    </div>
  );
}
