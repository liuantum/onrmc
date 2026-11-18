import { ReactNode, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { api } from '../lib/api';

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      <div className="flex gap-2 no-print">{actions}</div>
    </div>
  );
}

export function Stat({ label, value, hint, tone = 'slate' }: { label: string; value: ReactNode; hint?: string; tone?: 'slate' | 'green' | 'amber' | 'red' | 'blue' }) {
  const tones = { slate: 'text-slate-900', green: 'text-emerald-600', amber: 'text-amber-600', red: 'text-red-600', blue: 'text-brand-600' };
  return (
    <div className="card p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tones[tone]}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-400">{hint}</div>}
    </div>
  );
}

export interface Col<T> { key: string; label: string; render?: (r: T) => ReactNode; align?: 'right' }
export function Table<T extends { id?: string }>({ rows, cols, empty = 'Nothing here yet', onRow }: { rows: T[] | undefined; cols: Col<T>[]; empty?: string; onRow?: (r: T) => void }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full">
        <thead className="bg-slate-50"><tr>{cols.map((c) => <th key={c.key} className={`th ${c.align === 'right' ? 'text-right' : ''}`}>{c.label}</th>)}</tr></thead>
        <tbody>
          {!rows && <tr><td className="td text-slate-400" colSpan={cols.length}>Loading…</td></tr>}
          {rows?.length === 0 && <tr><td className="td py-10 text-center text-slate-400" colSpan={cols.length}>{empty}</td></tr>}
          {rows?.map((r, i) => (
            <tr key={r.id ?? i} onClick={onRow ? () => onRow(r) : undefined} className={onRow ? 'cursor-pointer hover:bg-slate-50' : ''}>
              {cols.map((c) => <td key={c.key} className={`td ${c.align === 'right' ? 'text-right tabular-nums' : ''}`}>{c.render ? c.render(r) : (r as any)[c.key]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Modal({ title, open, onClose, children, wide }: { title: string; open: boolean; onClose: () => void; children: ReactNode; wide?: boolean }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[1000] flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-16" onClick={onClose}>
      <div className={`card w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} p-6`} onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button className="btn-ghost p-1" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return <label className={`block ${className}`}><span className="label">{label}</span>{children}</label>;
}

const STATUS: Record<string, string> = {
  ISSUED: 'bg-blue-50 text-blue-700', PAID: 'bg-emerald-50 text-emerald-700', PARTIALLY_PAID: 'bg-amber-50 text-amber-700', CANCELLED: 'bg-red-50 text-red-700',
  DRAFT: 'bg-slate-100 text-slate-600', CONFIRMED: 'bg-blue-50 text-blue-700', IN_PROGRESS: 'bg-amber-50 text-amber-700', COMPLETED: 'bg-emerald-50 text-emerald-700',
  ASSIGNED: 'bg-slate-100 text-slate-600', LOADED: 'bg-indigo-50 text-indigo-700', IN_TRANSIT: 'bg-amber-50 text-amber-700', AT_SITE: 'bg-purple-50 text-purple-700',
  UNLOADING: 'bg-purple-50 text-purple-700', DELIVERED: 'bg-emerald-50 text-emerald-700', RETURNED: 'bg-slate-100 text-slate-600',
  PENDING: 'bg-amber-50 text-amber-700', GENERATED: 'bg-emerald-50 text-emerald-700', FAILED: 'bg-red-50 text-red-700', NOT_REQUIRED: 'bg-slate-100 text-slate-500',
  ACTIVE: 'bg-emerald-50 text-emerald-700', TRIAL: 'bg-blue-50 text-blue-700', PAST_DUE: 'bg-amber-50 text-amber-700', SUSPENDED: 'bg-red-50 text-red-700',
};
export const Badge = ({ s }: { s: string }) => <span className={`badge ${STATUS[s] ?? 'bg-slate-100 text-slate-600'}`}>{s.replace(/_/g, ' ').toLowerCase()}</span>;

/** POST helper that invalidates queries and surfaces errors. */
export function useSave(path: string | ((v: any) => string), invalidate: string[], onDone?: (d: any) => void) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (body: any) => api(typeof path === 'function' ? path(body) : path, { method: 'POST', body }),
    onSuccess: (d) => { setError(null); invalidate.forEach((k) => qc.invalidateQueries({ queryKey: [k] })); onDone?.(d); },
    onError: (e: Error) => setError(e.message),
  });
  return { ...m, error };
}

export const ErrorText = ({ error }: { error: string | null }) => (error ? <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null);

/** Uncontrolled form → plain object; numeric inputs become numbers. */
export function formData(e: React.FormEvent<HTMLFormElement>) {
  e.preventDefault();
  const out: Record<string, any> = {};
  for (const el of Array.from(e.currentTarget.elements) as HTMLInputElement[]) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.value === '') continue;
    else out[el.name] = el.type === 'number' ? Number(el.value) : el.value;
  }
  return out;
}

/** On/off switch that still posts as a checkbox through formData. */
export function Toggle({ name, defaultChecked, label, hint }: { name: string; defaultChecked?: boolean; label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input type="checkbox" name={name} defaultChecked={defaultChecked} className="peer sr-only" />
        <span className="h-6 w-11 rounded-full bg-slate-300 transition peer-checked:bg-emerald-500 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-500" />
        <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition peer-checked:translate-x-5" />
      </span>
      <span><span className="block text-base font-semibold">{label}</span>{hint && <span className="block text-xs text-slate-500">{hint}</span>}</span>
    </label>
  );
}
