import { useRef, useState } from 'react';
import { BadgeCheck, Loader2, RefreshCw, Search } from 'lucide-react';
import { api } from '../lib/api';

/** Which form inputs to fill from a GSTIN lookup (input names in the surrounding form). */
export interface GstinFill { name?: string; address?: string; city?: string; pincode?: string; stateCode?: string; phone?: string; email?: string }

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/**
 * GSTIN input that looks the number up as soon as it is complete and fills the rest of the form:
 * state and PAN always (they are inside the GSTIN), legal name / address / PIN from the GST system when
 * a GSP is connected, or from an existing customer / supplier with the same GSTIN.
 */
export function GstinField({ fill, label = 'GSTIN', defaultValue, onResult }: { fill: GstinFill; label?: string; defaultValue?: string; onResult?: (r: any) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [r, setR] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const last = useRef('');
  const [cap, setCap] = useState<{ token: string; image: string } | null>(null);
  const [capText, setCapText] = useState('');
  const [capBusy, setCapBusy] = useState(false);
  const [capErr, setCapErr] = useState<string | null>(null);

  function set(field: keyof GstinFill, value: unknown) {
    const nm = fill[field];
    if (!nm || value == null || value === '') return;
    const el = ref.current?.form?.elements.namedItem(nm) as HTMLInputElement | null;
    if (el) el.value = String(value);
  }
  async function look(force = false) {
    const g = (ref.current?.value ?? '').trim().toUpperCase();
    if (!GSTIN_RE.test(g) || (!force && g === last.current)) return;
    last.current = g; setBusy(true); setErr(null);
    try {
      const x = await api(`/gstin/${g}`);
      setR(x); onResult?.(x);
      if (!x.valid) return;
      set('stateCode', x.stateCode);
      apply(x.details, x.saved);
      if (x.portal) loadCaptcha();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  function apply(d: any, s?: any) {
    set('stateCode', d?.stateCode);
    set('name', d?.legalName ?? s?.name);
    set('address', d?.address ?? s?.address);
    set('city', d?.city ?? s?.city);
    set('pincode', d?.pincode ?? s?.pincode);
    set('phone', s?.phone); set('email', s?.email);
  }
  async function loadCaptcha() {
    setCapText(''); setCap(null);
    try { setCap(await api('/gstin-portal/captcha')); } catch (e) { setCapErr((e as Error).message); }
  }
  async function fetchPortal() {
    if (!cap || capText.trim().length < 4) return;
    setCapBusy(true); setCapErr(null);
    try {
      const x = await api(`/gstin/${last.current}/portal`, { body: { token: cap.token, captcha: capText } });
      setCap(null);
      setR((p: any) => ({ ...p, details: x.details, note: x.note, portal: false, source: x.details ? 'gst' : p.source }));
      apply(x.details, r?.saved);
    } catch (e) { setCapErr((e as Error).message); loadCaptcha(); } finally { setCapBusy(false); }
  }
  const d = r?.details;
  const inactive = d?.status && d.status !== 'ACT';
  return (
    <div className="block">
      <span className="label">{label}</span>
      <div className="relative">
        <input ref={ref} name="gstin" className="input pr-10 uppercase" maxLength={15} defaultValue={defaultValue} placeholder="Type the GSTIN to fill the details"
          onChange={(e) => { const v = e.target.value.toUpperCase(); if (v.length === 15) look(); else { setR(null); setCap(null); last.current = ''; } }} />
        <button type="button" title="Look up" className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-brand-600" onClick={() => look(true)}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
        </button>
      </div>
      {err && <span className="mt-1 block text-xs text-red-600">{err}</span>}
      {r && !r.valid && <span className="mt-1 block text-xs text-red-600">{r.error}</span>}
      {r?.valid && (
        <span className="mt-1 block space-y-0.5 text-xs">
          <span className="flex items-center gap-1 text-emerald-700"><BadgeCheck size={13} />{[r.stateName, r.pan && `PAN ${r.pan}`, r.entityType].filter(Boolean).join(' · ')}</span>
          {d && <span className={`block ${inactive || d.blocked ? 'text-red-600' : 'text-slate-600'}`}>{d.legalName}{d.tradeName && d.tradeName !== d.legalName ? ` (${d.tradeName})` : ''}{inactive ? ` · GST status: ${d.status === 'CNL' ? 'cancelled' : d.status === 'SUS' ? 'suspended' : d.status}` : ''}{d.blocked ? ' · blocked for e-invoicing' : ''}</span>}
          {r.existing && <span className="block text-amber-700">Already saved as {r.existing.kind} “{r.existing.name}”.</span>}
          {r.note && !r.existing && <span className="block text-slate-400">{r.note}</span>}
        </span>
      )}
      {r?.valid && r.portal && (
        <span className="mt-2 block rounded-lg border border-slate-200 bg-slate-50 p-2">
          <span className="mb-1 block text-xs text-slate-600">Fetch name and address free from the GST portal: type the characters you see.</span>
          <span className="flex flex-wrap items-center gap-2">
            {cap ? <img src={cap.image} alt="GST portal captcha" className="h-10 rounded border border-slate-200 bg-white" /> : <span className="flex h-10 w-32 items-center justify-center text-xs text-slate-400">{capErr ? '—' : 'Loading…'}</span>}
            <button type="button" title="New captcha" className="text-slate-400 hover:text-brand-600" onClick={loadCaptcha}><RefreshCw size={15} /></button>
            <input className="input w-28" value={capText} maxLength={10} placeholder="Captcha" autoComplete="off" inputMode="numeric"
              onChange={(e) => setCapText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); fetchPortal(); } }} />
            <button type="button" className="btn-primary" disabled={!cap || capBusy || capText.trim().length < 4} onClick={fetchPortal}>{capBusy ? 'Fetching…' : 'Fetch details'}</button>
          </span>
          {capErr && <span className="mt-1 block text-xs text-red-600">{capErr}</span>}
        </span>
      )}
    </div>
  );
}
