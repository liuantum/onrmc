import { Link } from 'react-router-dom';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TRIP_STATES } from '@onrmc/shared';
import { api, dateTime, qty } from '../lib/api';
import { Badge, ErrorText, Field, Modal, PageHeader, Table, useSave } from '../components/ui';

export default function Dispatch() {
  const { data: batches } = useQuery({ queryKey: ['batches'], queryFn: () => api('/batches'), refetchInterval: 15_000 });
  const { data: challans } = useQuery({ queryKey: ['challans'], queryFn: () => api('/challans'), refetchInterval: 15_000 });
  const [batch, setBatch] = useState<any>(null);
  const status = useSave((v) => `/challans/${v.id}/status`, ['challans', 'dashboard']);
  const waiting = batches?.filter((b: any) => !b.challan && !b.cancelledAt) ?? [];
  return (
    <>
      <PageHeader title="Dispatch" subtitle="Assign trucks to batches and follow every trip" />
      {waiting.length > 0 && (
        <div className="mb-6">
          <h2 className="mb-2 text-sm font-semibold text-slate-600">Batched, waiting for a truck</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {waiting.map((b: any) => (
              <button key={b.id} className="card border-amber-200 p-4 text-left hover:border-brand-500" onClick={() => setBatch(b)}>
                <div className="font-semibold">{b.order.mixDesign.grade} · {qty(b.quantityM3)} m³</div>
                <div className="text-sm text-slate-600">{b.order.customer.name}</div>
                <div className="text-xs text-slate-400">{b.number}</div>
              </button>
            ))}
          </div>
        </div>
      )}
      <Table rows={challans} cols={[
        { key: 'number', label: 'Challan', render: (c: any) => <Link className="font-medium text-brand-600 hover:underline" to={`/challans/${c.id}`}>{c.number}</Link> },
        { key: 'c', label: 'Customer / site', render: (c: any) => <><div className="font-medium">{c.order.customer.name}</div><div className="text-xs text-slate-500">{c.order.site.name}</div></> },
        { key: 'g', label: 'Load', render: (c: any) => `${c.order.mixDesign.grade} · ${qty(c.quantityM3)} m³` },
        { key: 'v', label: 'Truck / driver', render: (c: any) => <>{c.vehicle.number}<div className="text-xs text-slate-500">{c.driver?.name ?? '—'}</div></> },
        { key: 't', label: 'Created', render: (c: any) => dateTime(c.createdAt) },
        { key: 's', label: 'Status', render: (c: any) => (
          <select className="input py-1" value={c.status} onChange={(e) => status.mutate({ id: c.id, status: e.target.value })}>
            {TRIP_STATES.map((s) => <option key={s} value={s}>{s.replace('_', ' ').toLowerCase()}</option>)}
          </select>
        ) },
        { key: 'b', label: '', render: (c: any) => <Badge s={c.status} /> },
      ]} />
      <ErrorText error={status.error} />
      {batch && <AssignTruck batch={batch} onClose={() => setBatch(null)} />}
    </>
  );
}

function AssignTruck({ batch, onClose }: { batch: any; onClose: () => void }) {
  const { data: vehicles } = useQuery({ queryKey: ['vehicles'], queryFn: () => api('/vehicles') });
  const { data: users } = useQuery({ queryKey: ['users'], queryFn: () => api('/users').catch(() => []) });
  const save = useSave('/challans', ['challans', 'batches'], onClose);
  const [v, setV] = useState(''); const [d, setD] = useState('');
  return (
    <Modal title={`Dispatch ${batch.number}`} open onClose={onClose}>
      <div className="space-y-4">
        <Field label="Truck"><select className="input" value={v} onChange={(e) => setV(e.target.value)}><option value="">Select truck</option>{vehicles?.filter((x: any) => x.active).map((x: any) => <option key={x.id} value={x.id}>{x.number} ({qty(x.capacityM3)} m³)</option>)}</select></Field>
        <Field label="Driver"><select className="input" value={d} onChange={(e) => setD(e.target.value)}><option value="">Select driver</option>{users?.filter((u: any) => u.role === 'DRIVER').map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
        <div className="flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!v || save.isPending} onClick={() => save.mutate({ batchId: batch.id, vehicleId: v, driverId: d || undefined })}>Create challan</button></div>
      </div>
      <ErrorText error={save.error} />
    </Modal>
  );
}
