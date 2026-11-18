import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { computeLine, sumBreakups } from '@onrmc/shared';
import { Plus, Trash2 } from 'lucide-react';
import { api, date, money, qty } from '../lib/api';
import { Badge, ErrorText, Field, Modal, PageHeader, Table, useSave } from '../components/ui';

export default function Invoices() {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [einv, setEinv] = useState('');
  const { data } = useQuery({ queryKey: ['invoices', 'list', einv], queryFn: () => api(`/invoices${einv ? `?einvoiceStatus=${einv}` : ''}`) });
  return (
    <>
      <PageHeader title="Billing" subtitle="Invoices are generated from delivered challans" actions={<button className="btn-primary" onClick={() => setOpen(true)}><Plus size={16} />New invoice</button>} />
      <div className="mb-3 flex items-center gap-2 text-sm">
        <span className="text-slate-500">E-invoice</span>
        <select className="input w-48" value={einv} onChange={(e) => setEinv(e.target.value)}>
          <option value="">All</option><option value="PENDING">IRN pending</option><option value="FAILED">IRN failed</option>
          <option value="GENERATED">IRN generated</option><option value="CANCELLED">IRN cancelled</option><option value="NOT_REQUIRED">Not required</option>
        </select>
      </div>
      <Table rows={data} onRow={(i: any) => nav(`/invoices/${i.id}`)} cols={[
        { key: 'number', label: 'Number' },
        { key: 'type', label: 'Type', render: (i: any) => (i.type === 'TAX_INVOICE' ? 'Tax invoice' : 'Bill of supply') },
        { key: 'c', label: 'Customer', render: (i: any) => i.customer.name },
        { key: 'd', label: 'Date', render: (i: any) => date(i.issueDate) },
        { key: 'due', label: 'Due', render: (i: any) => date(i.dueDate) },
        { key: 't', label: 'Total', align: 'right', render: (i: any) => money(i.total) },
        { key: 'b', label: 'Balance', align: 'right', render: (i: any) => money(Number(i.total) + Number(i.noteAdj ?? 0) - Number(i.paid)) },
        { key: 's', label: 'Status', render: (i: any) => <Badge s={i.status} /> },
        { key: 'e', label: 'E-invoice', render: (i: any) => (i.einvoiceStatus === 'NOT_REQUIRED' ? <span className="text-xs text-slate-400">—</span> : <>
          <Badge s={i.einvoiceStatus} />{i.ewayBills?.[0] && <div className="mt-0.5 text-xs text-slate-500">EWB {i.ewayBills[0].ewbNo}</div>}</>) },
      ]} />
      {open && <NewInvoice onClose={() => setOpen(false)} />}
    </>
  );
}

function NewInvoice({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const [type, setType] = useState<'TAX_INVOICE' | 'BILL_OF_SUPPLY'>('TAX_INVOICE');
  const [customerId, setCustomerId] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [extras, setExtras] = useState<{ description: string; hsn: string; quantity: number; unit: string; rate: number; gstRate: number }[]>([]);
  const { data: customers } = useQuery({ queryKey: ['customers'], queryFn: () => api('/customers') });
  const { data: challans } = useQuery({ queryKey: ['challans', 'uninvoiced', customerId], queryFn: () => api(`/challans?uninvoiced=1&customerId=${customerId}`), enabled: !!customerId });
  const save = useSave('/invoices', ['invoices', 'challans', 'dashboard'], (inv) => nav(`/invoices/${inv.id}`));
  const gst = type === 'TAX_INVOICE';
  const sel = challans?.filter((c: any) => picked.includes(c.id)) ?? [];
  const preview = sumBreakups([
    ...sel.map((c: any) => computeLine({ quantity: Number(c.quantityM3), rate: Number(c.order.rate), gstRate: 18 }, false, gst)),
    ...extras.map((e) => computeLine(e, false, gst)),
  ]);
  return (
    <Modal title="New invoice" open onClose={onClose} wide>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Document type">
          <select className="input" value={type} onChange={(e) => setType(e.target.value as any)}>
            <option value="TAX_INVOICE">Tax invoice (GST)</option><option value="BILL_OF_SUPPLY">Bill of supply (non-GST)</option>
          </select>
        </Field>
        <Field label="Customer">
          <select className="input" value={customerId} onChange={(e) => { setCustomerId(e.target.value); setPicked([]); }}>
            <option value="">Select customer</option>{customers?.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
      </div>
      {customerId && (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between"><span className="label mb-0">Delivered, unbilled challans</span>
            {challans?.length > 0 && <button className="text-xs text-brand-600" onClick={() => setPicked(challans.map((c: any) => c.id))}>Select all</button>}</div>
          <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-200">
            {challans?.length === 0 && <div className="p-4 text-sm text-slate-400">No delivered challans waiting to be billed.</div>}
            {challans?.map((c: any) => (
              <label key={c.id} className="flex items-center gap-3 border-b border-slate-100 px-3 py-2 text-sm last:border-0">
                <input type="checkbox" checked={picked.includes(c.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))} />
                <span className="w-36">{c.number}</span><span className="flex-1">{c.order.mixDesign.grade} · {c.order.site.name}</span>
                <span className="tabular-nums">{qty(c.quantityM3)} m³ × {money(c.order.rate)}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between"><span className="label mb-0">Other charges (pumping, waiting, transport)</span>
          <button className="text-xs text-brand-600" onClick={() => setExtras([...extras, { description: 'Concrete pumping charges', hsn: '998719', quantity: 1, unit: 'NOS', rate: 0, gstRate: 18 }])}>+ Add charge</button></div>
        {extras.map((x, i) => (
          <div key={i} className="mb-2 grid grid-cols-[1fr_90px_70px_100px_70px_32px] gap-2">
            {(['description', 'hsn', 'quantity', 'rate', 'gstRate'] as const).map((k) => (
              <input key={k} className="input" placeholder={k} type={k === 'description' || k === 'hsn' ? 'text' : 'number'} value={x[k]} onChange={(e) => setExtras(extras.map((y, j) => (j === i ? { ...y, [k]: k === 'description' || k === 'hsn' ? e.target.value : Number(e.target.value) } : y)))} />
            ))}
            <button className="btn-ghost p-2" onClick={() => setExtras(extras.filter((_, j) => j !== i))}><Trash2 size={16} /></button>
          </div>
        ))}
      </div>
      <div className="mt-4 rounded-lg bg-slate-50 p-4 text-sm">
        <div className="flex justify-between"><span>Taxable value</span><span className="tabular-nums">{money(preview.taxable)}</span></div>
        {gst && <div className="flex justify-between text-slate-500"><span>GST (CGST+SGST or IGST by place of supply)</span><span className="tabular-nums">{money(preview.total - preview.taxable)}</span></div>}
        <div className="mt-1 flex justify-between font-semibold"><span>Estimated total</span><span className="tabular-nums">{money(Math.round(preview.total))}</span></div>
        <p className="mt-2 text-xs text-slate-400">Final amounts are calculated by the server from challan quantities.</p>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={!picked.length || save.isPending} onClick={() => save.mutate({ type, customerId, challanIds: picked, extras })}>Issue invoice</button>
      </div>
      <ErrorText error={save.error} />
    </Modal>
  );
}
