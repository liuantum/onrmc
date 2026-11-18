import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, dateTime, qty } from '../lib/api';
import { ErrorText, Field, Modal, PageHeader, Table, useSave } from '../components/ui';

export default function Batching() {
  const { data: orders } = useQuery({ queryKey: ['orders', 'open'], queryFn: async () => (await api('/orders')).filter((o: any) => ['CONFIRMED', 'IN_PROGRESS'].includes(o.status)) });
  const { data: batches } = useQuery({ queryKey: ['batches'], queryFn: () => api('/batches'), refetchInterval: 20_000 });
  const [order, setOrder] = useState<any>(null);
  const [cancel, setCancel] = useState<any>(null);
  const [reason, setReason] = useState('');
  const cancelSave = useSave(() => `/batches/${cancel.id}/cancel`, ['batches', 'orders', 'materials'], () => { setCancel(null); setReason(''); });
  return (
    <>
      <PageHeader title="Mixing / batching" subtitle="Record each batch with the actual weights from the plant" />
      <h2 className="mb-2 text-sm font-semibold text-slate-600">Open orders</h2>
      <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {orders?.length === 0 && <div className="text-sm text-slate-400">No open orders.</div>}
        {orders?.map((o: any) => {
          const done = o.challans.reduce((s: number, c: any) => s + Number(c.quantityM3), 0);
          return (
            <button key={o.id} onClick={() => setOrder(o)} className="card p-4 text-left hover:border-brand-500">
              <div className="flex justify-between"><span className="font-semibold">{o.mixDesign.grade}</span><span className="text-xs text-slate-500">{o.number}</span></div>
              <div className="text-sm">{o.customer.name} · {o.site.name}</div>
              <div className="mt-2 h-1.5 rounded bg-slate-100"><div className="h-1.5 rounded bg-brand-500" style={{ width: `${Math.min(100, (done / Number(o.quantityM3)) * 100)}%` }} /></div>
              <div className="mt-1 text-xs text-slate-500">{qty(done)} of {qty(o.quantityM3)} m³ dispatched</div>
            </button>
          );
        })}
      </div>
      <h2 className="mb-2 text-sm font-semibold text-slate-600">Recent batches</h2>
      <Table rows={batches} cols={[
        { key: 'number', label: 'Batch' },
        { key: 'o', label: 'Order', render: (b: any) => `${b.order.number} · ${b.order.customer.name}` },
        { key: 'g', label: 'Grade', render: (b: any) => b.order.mixDesign.grade },
        { key: 'q', label: 'Qty', align: 'right', render: (b: any) => `${qty(b.quantityM3)} m³` },
        { key: 'var', label: 'Variance vs design', render: (b: any) => {
          const off = b.consumption.filter((c: any) => Math.abs(Number(c.actualQty) - Number(c.designQty)) > Number(c.designQty) * 0.02);
          return off.length ? <span className="text-amber-700">{off.map((c: any) => c.material.name).join(', ')}</span> : <span className="text-emerald-700">within 2%</span>;
        } },
        { key: 'c', label: 'Challan', render: (b: any) => b.cancelledAt ? <span className="text-red-600">cancelled</span> : b.challan?.number ?? <span className="text-amber-600">not dispatched</span> },
        { key: 't', label: 'Time', render: (b: any) => dateTime(b.batchedAt) },
        { key: 'x', label: '', render: (b: any) => (!b.cancelledAt && !b.challan ? <button className="text-xs text-red-600" onClick={() => setCancel(b)}>Cancel</button> : null) },
      ]} />
      <Modal title={`Cancel batch ${cancel?.number ?? ''}`} open={!!cancel} onClose={() => setCancel(null)}>
        <p className="mb-3 text-sm text-slate-600">Only for a batch entered by mistake. Materials go back into stock and the cost posting is reversed.</p>
        <input className="input" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className="mt-4 flex justify-end"><button className="btn-danger" disabled={reason.trim().length < 5 || cancelSave.isPending} onClick={() => cancelSave.mutate({ reason: reason.trim() })}>Cancel batch</button></div>
        <ErrorText error={cancelSave.error} />
      </Modal>
      {order && <BatchForm order={order} onClose={() => setOrder(null)} />}
    </>
  );
}

function BatchForm({ order, onClose }: { order: any; onClose: () => void }) {
  const { data: mixes } = useQuery({ queryKey: ['mix-designs'], queryFn: () => api('/mix-designs') });
  const { data: plants } = useQuery({ queryKey: ['plants'], queryFn: () => api('/plants') });
  const mix = mixes?.find((m: any) => m.grade === order.mixDesign.grade);
  const [m3, setM3] = useState(6);
  const [actuals, setActuals] = useState<Record<string, number>>({});
  const save = useSave('/batches', ['batches', 'orders'], onClose);
  return (
    <Modal title={`Batch for ${order.number} · ${order.mixDesign.grade}`} open onClose={onClose} wide>
      <div className="mb-4 grid grid-cols-2 gap-4">
        <Field label="Plant"><select id="plant" className="input">{plants?.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Batch quantity (m³)"><input type="number" step="0.5" min="0.5" max="12" className="input" value={m3} onChange={(e) => setM3(Number(e.target.value))} /></Field>
      </div>
      <table className="w-full text-sm">
        <thead><tr><th className="th">Material</th><th className="th text-right">Design</th><th className="th text-right">Actual from plant</th></tr></thead>
        <tbody>
          {mix?.items.map((it: any) => {
            const design = Number(it.qtyPerM3) * m3;
            return (
              <tr key={it.id}>
                <td className="td">{it.material.name}</td>
                <td className="td text-right tabular-nums">{qty(design, 1)} {it.material.unit}</td>
                <td className="td text-right"><input type="number" step="0.1" className="input w-32 text-right" placeholder={qty(design, 1)} value={actuals[it.materialId] ?? ''} onChange={(e) => setActuals({ ...actuals, [it.materialId]: e.target.value === '' ? (undefined as any) : Number(e.target.value) })} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-slate-500">Leave blank to use the design weight. Stock is deducted by the actual weight.</p>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate({ orderId: order.id, plantId: (document.getElementById('plant') as HTMLSelectElement).value, quantityM3: m3, actuals: Object.fromEntries(Object.entries(actuals).filter(([, v]) => v !== undefined)) })}>Record batch</button>
      </div>
      <ErrorText error={save.error} />
    </Modal>
  );
}
