import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api, dateTime, money, qty } from '../lib/api';
import { Badge, ErrorText, Field, Modal, PageHeader, Table, formData, useSave } from '../components/ui';
import { CustomerForm } from '../components/CustomerForm';

export default function Orders() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState('');
  const { data } = useQuery({ queryKey: ['orders', status], queryFn: () => api(`/orders${status ? `?status=${status}` : ''}`) });
  return (
    <>
      <PageHeader title="Orders" subtitle="Customer bookings by site and grade" actions={<button className="btn-primary" onClick={() => setOpen(true)}><Plus size={16} />New order</button>} />
      <div className="mb-4 flex gap-2">
        {['', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'].map((s) => (
          <button key={s} onClick={() => setStatus(s)} className={`btn ${status === s ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200'}`}>{s ? s.replace('_', ' ').toLowerCase() : 'all'}</button>
        ))}
      </div>
      <Table rows={data} cols={[
        { key: 'number', label: 'Order' },
        { key: 'customer', label: 'Customer / site', render: (o: any) => <><div className="font-medium">{o.customer.name}</div><div className="text-xs text-slate-500">{o.site.name}</div></> },
        { key: 'grade', label: 'Grade', render: (o: any) => o.mixDesign.grade },
        { key: 'qty', label: 'Delivered / ordered', align: 'right', render: (o: any) => `${qty(o.challans.filter((c: any) => c.status === 'DELIVERED' || c.status === 'RETURNED').reduce((s: number, c: any) => s + Number(c.quantityM3), 0))} / ${qty(o.quantityM3)} m³` },
        { key: 'rate', label: 'Rate', align: 'right', render: (o: any) => money(o.rate) },
        { key: 'when', label: 'Scheduled', render: (o: any) => dateTime(o.scheduledAt) },
        { key: 'status', label: 'Status', render: (o: any) => <Badge s={o.status} /> },
      ]} />
      <NewOrder open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function NewOrder({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: customers } = useQuery({ queryKey: ['customers'], queryFn: () => api('/customers'), enabled: open });
  const { data: mixes } = useQuery({ queryKey: ['mix-designs'], queryFn: () => api('/mix-designs'), enabled: open });
  const [cid, setCid] = useState('');
  const [adding, setAdding] = useState(false);
  const save = useSave('/orders', ['orders'], onClose);
  const sites = customers?.find((c: any) => c.id === cid)?.sites ?? [];
  return (
    <Modal title="New order" open={open} onClose={onClose}>
      <form className="grid grid-cols-2 gap-4" onSubmit={(e) => { const d = formData(e); save.mutate({ ...d, scheduledAt: new Date(d.scheduledAt).toISOString() }); }}>
        <Field label="Customer" className="col-span-2">
          <div className="flex gap-2">
            <select name="customerId" className="input" required value={cid} onChange={(e) => setCid(e.target.value)}>
              <option value="">Select customer</option>{customers?.map((c: any) => <option key={c.id} value={c.id}>{c.name}{c.gstin ? ` · ${c.gstin}` : ''}</option>)}
            </select>
            <button type="button" className="btn-ghost shrink-0 border border-slate-200" onClick={() => setAdding(true)}><Plus size={15} />New</button>
          </div>
        </Field>
        <Field label="Site" className="col-span-2">
          <select name="siteId" className="input" required><option value="">{cid ? (sites.length ? 'Select site' : 'Add a site under Customers first') : 'Pick customer first'}</option>{sites.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        </Field>
        <Field label="Grade"><select name="mixDesignId" className="input" required>{mixes?.map((m: any) => <option key={m.id} value={m.id}>{m.grade} · {money(m.baseRate)}/m³</option>)}</select></Field>
        <Field label="Quantity (m³)"><input name="quantityM3" type="number" step="0.5" min="0.5" className="input" required /></Field>
        <Field label="Rate per m³ (blank = customer rate)"><input name="rate" type="number" step="1" className="input" /></Field>
        <Field label="Scheduled at"><input name="scheduledAt" type="datetime-local" className="input" required /></Field>
        <label className="col-span-2 flex items-center gap-2 text-sm"><input name="pumpRequired" type="checkbox" /> Pump required</label>
        <Field label="Notes" className="col-span-2"><input name="notes" className="input" /></Field>
        <div className="col-span-2 flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={save.isPending}>Save order</button></div>
      </form>
      <ErrorText error={save.error} />
      <Modal title="New customer" open={adding} onClose={() => setAdding(false)}>
        <CustomerForm withSite onSaved={(c) => { setCid(c.id); setAdding(false); }} />
      </Modal>
    </Modal>
  );
}
