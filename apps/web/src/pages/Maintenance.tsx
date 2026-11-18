import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Gauge, Plus, Wrench } from 'lucide-react';
import { api, date, money, session } from '../lib/api';
import { ErrorText, Field, Modal, PageHeader, Stat, Table, formData, useSave } from '../components/ui';

const TONE: Record<string, string> = { OVERDUE: 'bg-red-50 text-red-700', DUE_SOON: 'bg-amber-50 text-amber-700', OK: 'bg-emerald-50 text-emerald-700', NO_BASELINE: 'bg-slate-100 text-slate-500' };
const Due = ({ s }: { s: string }) => <span className={`badge ${TONE[s]}`}>{s === 'NO_BASELINE' ? 'needs odometer' : s.replace('_', ' ').toLowerCase()}</span>;

function dueText(s: any) {
  const p: string[] = [];
  if (s.daysLeft != null) p.push(s.daysLeft < 0 ? `${-s.daysLeft} days late` : `in ${s.daysLeft} days`);
  if (s.kmLeft != null) p.push(s.kmLeft < 0 ? `${(-s.kmLeft).toLocaleString('en-IN')} km over` : `${s.kmLeft.toLocaleString('en-IN')} km left`);
  return p.join(' · ') || '—';
}

export default function Maintenance() {
  const canEdit = ['OWNER', 'MANAGER', 'DISPATCH'].includes(session.get()?.user.role ?? '');
  const { data } = useQuery({ queryKey: ['maintenance'], queryFn: () => api('/fleet/maintenance') });
  const { data: records } = useQuery({ queryKey: ['maintenance-records'], queryFn: () => api('/fleet/records') });
  const [truck, setTruck] = useState<any>(null);
  const [rec, setRec] = useState<{ vehicle: any; schedule?: any } | null>(null);
  const [sched, setSched] = useState<any>(null);
  const [odo, setOdo] = useState<any>(null);
  const [cancel, setCancel] = useState<any>(null);
  const keys = ['maintenance', 'maintenance-records'];
  const saveRec = useSave('/fleet/records', keys, () => setRec(null));
  const saveSched = useSave('/fleet/schedules', keys, () => setSched(null));
  const saveOdo = useSave((v) => `/vehicles/${v.id}/odometer`, keys, () => setOdo(null));
  const template = useSave('/fleet/schedules/template', keys);
  const doCancel = useSave((v) => `/fleet/records/${v.id}/cancel`, keys, () => setCancel(null));
  const vs: any[] = data?.vehicles ?? [];
  const sel = truck ? vs.find((v) => v.id === truck) : null;
  const sum = (k: string) => vs.reduce((a, v) => a + v.cost[k], 0);
  return (
    <>
      <PageHeader title="Truck maintenance" subtitle={data ? `Service schedules and running cost · ${date(data.from)} to ${date(data.to)}` : ''} actions={canEdit && <button className="btn-ghost" disabled={template.isPending} onClick={() => template.mutate({})}><Plus size={16} />Add standard schedule to mixers</button>} />
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Overdue" value={vs.reduce((a, v) => a + v.schedules.filter((s: any) => s.status === 'OVERDUE').length, 0)} tone="red" hint="service tasks" />
        <Stat label="Due in 7 days / 500 km" value={vs.reduce((a, v) => a + v.schedules.filter((s: any) => s.status === 'DUE_SOON').length, 0)} tone="amber" />
        <Stat label="Repairs & service" value={money(sum('maintenance'))} hint="this financial year" />
        <Stat label="Diesel on trips" value={money(sum('diesel'))} hint="from challans" />
      </div>
      {template.data && <p className="mb-4 text-sm text-slate-500">Added {template.data.created} service tasks.</p>}
      <Table rows={vs} empty="Add trucks under Setup first" onRow={(v: any) => setTruck(v.id)} cols={[
        { key: 'number', label: 'Truck', render: (v: any) => <><div className="font-medium">{v.number}</div><div className="text-xs text-slate-500">{v.type.replace('_', ' ').toLowerCase()}</div></> },
        { key: 'odo', label: 'Odometer', render: (v: any) => (v.odometerKm != null ? `${v.odometerKm.toLocaleString('en-IN')} km` : '—') },
        { key: 'status', label: 'Service', render: (v: any) => (v.schedules.length ? <><Due s={v.status} /><div className="text-xs text-slate-500">{v.schedules.filter((s: any) => s.status !== 'OK').map((s: any) => s.task).slice(0, 2).join(', ')}</div></> : <span className="text-xs text-slate-400">no schedule</span>) },
        { key: 'm', label: 'Repairs', align: 'right', render: (v: any) => money(v.cost.maintenance) },
        { key: 'd', label: 'Diesel', align: 'right', render: (v: any) => money(v.cost.diesel) },
        { key: 'p', label: 'Cost / m³', align: 'right', render: (v: any) => (v.cost.perM3 != null ? money(v.cost.perM3) : '—') },
        { key: 'dt', label: 'Downtime', align: 'right', render: (v: any) => (v.cost.downtimeHrs ? `${v.cost.downtimeHrs} h` : '—') },
      ]} />

      <h2 className="mb-3 mt-8 text-lg font-semibold">Service log</h2>
      <Table rows={records} empty="No services recorded yet" cols={[
        { key: 'date', label: 'Date', render: (r: any) => <><div>{date(r.date)}</div><div className="text-xs text-slate-500">{r.number}</div></> },
        { key: 'v', label: 'Truck', render: (r: any) => r.vehicle.number },
        { key: 'd', label: 'Work', render: (r: any) => <><div className={r.cancelledAt ? 'line-through text-slate-400' : ''}>{r.description}</div><div className="text-xs text-slate-500">{[r.schedule?.task, r.vendor, r.odometerKm && `${r.odometerKm.toLocaleString('en-IN')} km`].filter(Boolean).join(' · ')}</div>{r.cancelledAt && <div className="text-xs text-red-600">Cancelled: {r.cancelReason}</div>}</> },
        { key: 'p', label: 'Paid', render: (r: any) => (r.paidVia === 'PURCHASE_BILL' ? `bill ${r.billRef}` : r.paidVia.toLowerCase()) },
        { key: 't', label: 'Cost', align: 'right', render: (r: any) => money(r.totalCost) },
        { key: 'a', label: '', render: (r: any) => canEdit && !r.cancelledAt && <button className="btn-ghost text-xs" onClick={(e) => { e.stopPropagation(); setCancel(r); }}>Cancel</button> },
      ]} />

      <Modal title={sel ? `${sel.number} · service plan` : ''} open={!!sel} onClose={() => setTruck(null)} wide>
        {sel && <>
          <div className="mb-4 flex flex-wrap gap-2">
            {canEdit && <button className="btn-primary" onClick={() => setRec({ vehicle: sel })}><Wrench size={16} />Record service / repair</button>}
            {canEdit && <button className="btn-ghost" onClick={() => setSched(sel)}><Plus size={16} />Add task</button>}
            {canEdit && <button className="btn-ghost" onClick={() => setOdo(sel)}><Gauge size={16} />Update odometer</button>}
          </div>
          <Table rows={sel.schedules} empty="No service tasks yet" cols={[
            { key: 'task', label: 'Task', render: (s: any) => <><div className="font-medium">{s.task}</div><div className="text-xs text-slate-500">every {[s.everyKm && `${s.everyKm.toLocaleString('en-IN')} km`, s.everyDays && `${s.everyDays} days`].filter(Boolean).join(' or ')}</div></> },
            { key: 'last', label: 'Last done', render: (s: any) => (s.lastDoneAt ? `${date(s.lastDoneAt)}${s.lastDoneKm != null ? ` · ${s.lastDoneKm.toLocaleString('en-IN')} km` : ''}` : 'never') },
            { key: 'due', label: 'Due', render: (s: any) => <><Due s={s.status} /><div className="text-xs text-slate-500">{dueText(s)}</div></> },
            { key: 'a', label: '', render: (s: any) => canEdit && <button className="btn-ghost text-xs" onClick={() => setRec({ vehicle: sel, schedule: s })}>Mark done</button> },
          ]} />
        </>}
      </Modal>

      <Modal title={rec ? `Service · ${rec.vehicle.number}` : ''} open={!!rec} onClose={() => setRec(null)}>
        {rec && <form className="grid grid-cols-2 gap-4" onSubmit={(e) => { const d = formData(e); saveRec.mutate({ ...d, vehicleId: rec.vehicle.id, scheduleId: d.scheduleId || null }); }}>
          <Field label="Task" className="col-span-2"><select name="scheduleId" className="input" defaultValue={rec.schedule?.id ?? ''}><option value="">Repair / other (not scheduled)</option>{rec.vehicle.schedules.map((s: any) => <option key={s.id} value={s.id}>{s.task}</option>)}</select></Field>
          <Field label="Work done" className="col-span-2"><input name="description" className="input" required defaultValue={rec.schedule?.task ?? ''} /></Field>
          <Field label="Date"><input name="date" type="date" className="input" required defaultValue={new Date().toISOString().slice(0, 10)} /></Field>
          <Field label="Odometer (km)"><input name="odometerKm" type="number" className="input" defaultValue={rec.vehicle.odometerKm ?? ''} /></Field>
          <Field label="Parts ₹"><input name="partsCost" type="number" step="0.01" className="input" defaultValue={0} /></Field>
          <Field label="Labour ₹"><input name="labourCost" type="number" step="0.01" className="input" defaultValue={0} /></Field>
          <Field label="Garage / vendor"><input name="vendor" className="input" /></Field>
          <Field label="Downtime (hours)"><input name="downtimeHrs" type="number" step="0.5" className="input" /></Field>
          <Field label="Paid from"><select name="paidVia" className="input"><option value="CASH">Cash</option><option value="BANK">Bank</option><option value="PURCHASE_BILL">Already on a purchase bill</option></select></Field>
          <Field label="Bill no. (if on a purchase bill)"><input name="billRef" className="input" /></Field>
          <p className="col-span-2 text-xs text-slate-500">Cash or bank posts Dr Vehicle repairs & maintenance. If the garage's GST bill is entered under Purchase bills, choose that option so the cost isn't counted twice.</p>
          <div className="col-span-2 flex justify-end"><button className="btn-primary" disabled={saveRec.isPending}>Save</button></div>
          <div className="col-span-2"><ErrorText error={saveRec.error} /></div>
        </form>}
      </Modal>

      <Modal title={sched ? `New service task · ${sched.number}` : ''} open={!!sched} onClose={() => setSched(null)}>
        {sched && <form className="grid grid-cols-2 gap-4" onSubmit={(e) => saveSched.mutate({ ...formData(e), vehicleId: sched.id })}>
          <Field label="Task" className="col-span-2"><input name="task" className="input" required placeholder="Engine oil + filter" /></Field>
          <Field label="Every (km)"><input name="everyKm" type="number" className="input" /></Field>
          <Field label="Every (days)"><input name="everyDays" type="number" className="input" /></Field>
          <Field label="Last done on"><input name="lastDoneAt" type="date" className="input" /></Field>
          <Field label="Last done at (km)"><input name="lastDoneKm" type="number" className="input" /></Field>
          <div className="col-span-2 flex justify-end"><button className="btn-primary" disabled={saveSched.isPending}>Add</button></div>
          <div className="col-span-2"><ErrorText error={saveSched.error} /></div>
        </form>}
      </Modal>

      <Modal title={odo ? `Odometer · ${odo.number}` : ''} open={!!odo} onClose={() => setOdo(null)}>
        {odo && <form className="space-y-4" onSubmit={(e) => saveOdo.mutate({ ...formData(e), id: odo.id })}>
          <Field label="Current reading (km)"><input name="km" type="number" className="input" required min={odo.odometerKm ?? 0} defaultValue={odo.odometerKm ?? ''} /></Field>
          <div className="flex justify-end"><button className="btn-primary" disabled={saveOdo.isPending}>Save</button></div>
          <ErrorText error={saveOdo.error} />
        </form>}
      </Modal>

      <Modal title="Cancel service entry" open={!!cancel} onClose={() => setCancel(null)}>
        <form className="space-y-4" onSubmit={(e) => doCancel.mutate({ ...formData(e), id: cancel.id })}>
          <p className="text-sm text-slate-600">The expense entry is reversed in the books.</p>
          <Field label="Reason"><input name="reason" className="input" required minLength={3} /></Field>
          <div className="flex justify-end"><button className="btn-danger" disabled={doCancel.isPending}>Cancel entry</button></div>
          <ErrorText error={doCancel.error} />
        </form>
      </Modal>
    </>
  );
}
