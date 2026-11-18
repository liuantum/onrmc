import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FlaskConical, Plus } from 'lucide-react';
import { api, date, session } from '../lib/api';
import { ErrorText, Field, Modal, PageHeader, Stat, Table, formData, useSave } from '../components/ui';

const Pass = ({ ok, kind }: { ok: boolean; kind: string }) => <span className={`badge ${ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>{ok ? (kind === 'ACCEPTANCE' ? 'pass' : 'on track') : kind === 'ACCEPTANCE' ? 'fail' : 'low'}</span>;

export default function Qc() {
  const canEdit = ['OWNER', 'MANAGER', 'BATCHING'].includes(session.get()?.user.role ?? '');
  const [pending, setPending] = useState(false);
  const { data: sets } = useQuery({ queryKey: ['cube-sets', pending], queryFn: () => api(`/qc/cube-sets${pending ? '?pending=true' : ''}`) });
  const { data: summary } = useQuery({ queryKey: ['qc-summary'], queryFn: () => api('/qc/summary') });
  const { data: batches } = useQuery({ queryKey: ['batches'], queryFn: () => api('/batches'), enabled: canEdit });
  const [sample, setSample] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [n, setN] = useState(3);
  const keys = ['cube-sets', 'qc-summary'];
  const saveSet = useSave('/qc/cube-sets', keys, () => setSample(false));
  const saveRes = useSave((v) => `/qc/cube-sets/${v.id}/results`, keys, () => setResult(null));
  const due = sets?.filter((s: any) => s.testDue).length ?? 0;

  function submitResults(e: React.FormEvent<HTMLFormElement>) {
    const d = formData(e);
    const mode = d.mode as 'load' | 'mpa';
    const cubes = Array.from({ length: n }, (_, i) => d[`c${i}`]).filter((x) => x != null).map((x: number) => (mode === 'load' ? { loadKn: x } : { strengthMpa: x }));
    saveRes.mutate({ id: result.id, ageDays: Number(d.ageDays), testedAt: d.testedAt, cubes });
  }
  return (
    <>
      <PageHeader title="Quality control" subtitle="Cube tests per batch, checked against IS 456" actions={canEdit && <button className="btn-primary" onClick={() => setSample(true)}><Plus size={16} />Cast cubes from a batch</button>} />
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Tests due now" value={due} tone={due ? 'amber' : 'slate'} hint="7 / 28 day" />
        {summary?.slice(0, 3).map((g: any) => (
          <Stat key={g.grade} label={`${g.grade} · ${g.samples} samples`} value={`${g.average} N/mm²`} tone={g.failedSamples || g.groupPass === false ? 'red' : 'green'}
            hint={g.last4GroupMean != null ? `last 4 mean ${g.last4GroupMean} (need ≥ ${g.groupRequired})${g.stdDev != null ? ` · sd ${g.stdDev}` : ''}` : `${g.failedSamples} failed · need 4 samples for group check`} />
        ))}
      </div>
      <div className="mb-4 inline-flex rounded-lg bg-slate-100 p-1 text-sm">
        {[[false, 'All cube sets'], [true, 'Due for testing']].map(([k, l]) => <button key={String(k)} onClick={() => setPending(k as boolean)} className={`rounded-md px-3 py-1.5 font-medium ${pending === k ? 'bg-white shadow-sm' : 'text-slate-500'}`}>{l as string}</button>)}
      </div>
      <Table rows={sets} empty={pending ? 'Nothing due' : 'No cubes cast yet'} cols={[
        { key: 'n', label: 'Set', render: (s: any) => <><div className="font-medium">{s.number}</div><div className="text-xs text-slate-500">{date(s.sampledAt)} · day {s.ageNow}</div></> },
        { key: 'b', label: 'Batch / customer', render: (s: any) => <><div>{s.batch.number}{s.batch.challan && ` · ${s.batch.challan.number}`}</div><div className="text-xs text-slate-500">{s.batch.order.customer.name} · {s.batch.order.site.name}</div></> },
        { key: 'g', label: 'Grade', render: (s: any) => s.grade },
        { key: 'f', label: 'Fresh', render: (s: any) => [s.slumpMm != null && `slump ${s.slumpMm} mm`, s.tempC != null && `${Number(s.tempC)}°C`].filter(Boolean).join(' · ') || '—' },
        { key: 'r', label: 'Results (N/mm²)', render: (s: any) => s.byAge.length ? s.byAge.map((a: any) => <div key={a.ageDays} className="flex items-center gap-2"><span className="w-10 text-xs text-slate-500">{a.ageDays} d</span><span className="tabular-nums">{a.mean}</span><Pass ok={a.pass} kind={a.kind} />{!a.spreadOk && <span className="text-xs text-red-600">cube spread &gt;15%</span>}</div>) : <span className="text-slate-400">—</span> },
        { key: 'a', label: '', render: (s: any) => canEdit && <button className={s.testDue ? 'btn-primary' : 'btn-ghost'} onClick={() => { setN(3); setResult(s); }}><FlaskConical size={15} />{s.testDue ? `${s.testDue}-day test` : 'Add result'}</button> },
      ]} />
      <p className="mt-3 text-xs text-slate-500">28-day acceptance: each sample ≥ fck − 4 (M20+) or fck − 3 (M15), and the mean of 4 consecutive samples ≥ fck + 4 (M20+) or fck + 3 (M15). 7-day results are indicative (about 65% of fck expected).</p>

      <Modal title="Cast cubes" open={sample} onClose={() => setSample(false)}>
        <form className="grid grid-cols-2 gap-4" onSubmit={(e) => { const d = formData(e); saveSet.mutate({ ...d, cubeSizeMm: Number(d.cubeSizeMm) }); }}>
          <Field label="Batch" className="col-span-2"><select name="batchId" className="input" required>{batches?.filter((b: any) => !b.cancelledAt).map((b: any) => <option key={b.id} value={b.id}>{b.number} · {b.order.mixDesign.grade} · {b.order.customer.name} · {date(b.batchedAt)}</option>)}</select></Field>
          <Field label="Slump (mm)"><input name="slumpMm" type="number" className="input" /></Field>
          <Field label="Concrete temp (°C)"><input name="tempC" type="number" step="0.1" className="input" /></Field>
          <Field label="Cube size"><select name="cubeSizeMm" className="input"><option value="150">150 mm</option><option value="100">100 mm</option></select></Field>
          <Field label="Notes"><input name="notes" className="input" /></Field>
          <div className="col-span-2 flex justify-end"><button className="btn-primary" disabled={saveSet.isPending}>Save</button></div>
          <div className="col-span-2"><ErrorText error={saveSet.error} /></div>
        </form>
      </Modal>

      <Modal title={result ? `${result.number} · ${result.grade} crushing results` : ''} open={!!result} onClose={() => setResult(null)}>
        {result && <form className="grid grid-cols-2 gap-4" onSubmit={submitResults}>
          <Field label="Age (days)"><select name="ageDays" className="input" defaultValue={result.testDue ?? 28}>{[3, 7, 14, 28, 56].map((a) => <option key={a} value={a}>{a}</option>)}</select></Field>
          <Field label="Tested on"><input name="testedAt" type="date" className="input" defaultValue={new Date().toISOString().slice(0, 10)} /></Field>
          <Field label="Enter" className="col-span-2"><select name="mode" className="input"><option value="load">Failure load (kN) — strength is calculated</option><option value="mpa">Strength (N/mm²)</option></select></Field>
          {Array.from({ length: n }, (_, i) => <Field key={i} label={`Cube ${i + 1}`}><input name={`c${i}`} type="number" step="0.1" className="input" required={i === 0} /></Field>)}
          <div className="col-span-2 flex justify-between">
            <button type="button" className="btn-ghost text-xs" onClick={() => setN(Math.min(6, n + 1))}>+ cube</button>
            <button className="btn-primary" disabled={saveRes.isPending}>Save results</button>
          </div>
          <div className="col-span-2"><ErrorText error={saveRes.error} /></div>
        </form>}
      </Modal>
    </>
  );
}
