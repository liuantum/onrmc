import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api, date, money, qty } from '../lib/api';
import { ErrorText, Field, Modal, PageHeader, Table, useSave } from '../components/ui';

export default function Inventory() {
  const [grn, setGrn] = useState(false);
  const { data: mats } = useQuery({ queryKey: ['materials'], queryFn: () => api('/materials') });
  const { data: receipts } = useQuery({ queryKey: ['receipts'], queryFn: () => api('/receipts').catch(() => []) });
  return (
    <>
      <PageHeader title="Aggregates & stock" subtitle="Cement, fly ash, aggregates, sand and admixtures" actions={<button className="btn-primary" onClick={() => setGrn(true)}><Plus size={16} />Material inward</button>} />
      <Table rows={mats} cols={[
        { key: 'name', label: 'Material' },
        { key: 'kind', label: 'Type', render: (m: any) => m.kind.replace(/_/g, ' ').toLowerCase() },
        { key: 'stock', label: 'In stock', align: 'right', render: (m: any) => {
          const q = m.stock.reduce((s: number, x: any) => s + Number(x.quantity), 0);
          return <span className={q <= Number(m.reorderLevel) ? 'font-semibold text-red-600' : ''}>{qty(q, 0)} {m.unit}</span>;
        } },
        { key: 'reorder', label: 'Reorder at', align: 'right', render: (m: any) => `${qty(m.reorderLevel, 0)} ${m.unit}` },
        { key: 'cost', label: 'Avg cost', align: 'right', render: (m: any) => `${money(m.avgCost)}/${m.unit}` },
      ]} />
      <h2 className="mb-2 mt-8 text-sm font-semibold text-slate-600">Recent inward (GRN)</h2>
      <Table rows={receipts} cols={[
        { key: 'number', label: 'GRN' }, { key: 'd', label: 'Date', render: (r: any) => date(r.receivedAt) },
        { key: 's', label: 'Supplier', render: (r: any) => r.supplier.name }, { key: 'v', label: 'Vehicle', render: (r: any) => r.vehicleNo ?? '—' },
        { key: 'l', label: 'Items', render: (r: any) => r.lines.map((l: any) => `${l.material.name} ${qty(l.quantity, 0)} ${l.material.unit}`).join(', ') },
        { key: 'a', label: 'Amount', align: 'right', render: (r: any) => <>{money(Number(r.amount) + Number(r.gstAmount))}<div className="text-xs text-slate-400">{r.bill ? `billed ${r.bill.number}` : r.legacyPosted ? 'posted' : 'awaiting bill'}</div></> },
      ]} />
      {grn && <Grn mats={mats ?? []} onClose={() => setGrn(false)} />}
    </>
  );
}

function Grn({ mats, onClose }: { mats: any[]; onClose: () => void }) {
  const { data: suppliers } = useQuery({ queryKey: ['suppliers'], queryFn: () => api('/suppliers') });
  const { data: plants } = useQuery({ queryKey: ['plants'], queryFn: () => api('/plants') });
  const [lines, setLines] = useState([{ materialId: '', quantity: 0, rate: 0 }]);
  const [h, setH] = useState<any>({});
  const save = useSave('/receipts', ['materials', 'receipts'], onClose);
  const amount = lines.reduce((s, l) => s + l.quantity * l.rate, 0);
  return (
    <Modal title="Material inward" open onClose={onClose} wide>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Field label="Plant"><select className="input" onChange={(e) => setH({ ...h, plantId: e.target.value })}><option value="">Select</option>{plants?.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Supplier"><select className="input" onChange={(e) => setH({ ...h, supplierId: e.target.value })}><option value="">Select</option>{suppliers?.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Challan / bill ref."><input className="input" onChange={(e) => setH({ ...h, supplierBillNo: e.target.value })} /></Field>
        <Field label="Vehicle no."><input className="input" onChange={(e) => setH({ ...h, vehicleNo: e.target.value })} /></Field>
      </div>
      <div className="mt-4 space-y-2">
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[1fr_120px_120px_32px] gap-2">
            <select className="input" value={l.materialId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, materialId: e.target.value } : x)))}><option value="">Material</option>{mats.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.unit})</option>)}</select>
            <input className="input" type="number" placeholder="Quantity" onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: Number(e.target.value) } : x)))} />
            <input className="input" type="number" step="0.01" placeholder="Rate" onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, rate: Number(e.target.value) } : x)))} />
            <button className="btn-ghost p-2" onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 size={16} /></button>
          </div>
        ))}
        <button className="text-sm text-brand-600" onClick={() => setLines([...lines, { materialId: '', quantity: 0, rate: 0 }])}>+ Add line</button>
      </div>
      <div className="mt-4 flex items-end justify-between">
        <p className="text-xs text-slate-500">Stock is valued at these rates. GST and the final rate come from the supplier's bill (Purchases → Purchase bills).</p>
        <div className="text-right text-sm">Material value <b>{money(amount)}</b></div>
      </div>
      <div className="mt-4 flex justify-end"><button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate({ ...h, lines: lines.filter((l) => l.materialId && l.quantity > 0) })}>Save inward</button></div>
      <ErrorText error={save.error} />
    </Modal>
  );
}
