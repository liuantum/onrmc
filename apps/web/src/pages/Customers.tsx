import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api, money } from '../lib/api';
import { ErrorText, Field, Modal, PageHeader, Table, formData, useSave } from '../components/ui';
import { CustomerForm } from '../components/CustomerForm';

export default function Customers() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [siteFor, setSiteFor] = useState<any>(null);
  const { data } = useQuery({ queryKey: ['customers', q], queryFn: () => api(`/customers?q=${encodeURIComponent(q)}`) });
  const saveSite = useSave(() => `/customers/${siteFor.id}/sites`, ['customers'], () => setSiteFor(null));
  return (
    <>
      <PageHeader title="Customers" actions={<button className="btn-primary" onClick={() => setOpen(true)}><Plus size={16} />Add customer</button>} />
      <input className="input mb-4 max-w-sm" placeholder="Search customers…" value={q} onChange={(e) => setQ(e.target.value)} />
      <Table rows={data} cols={[
        { key: 'name', label: 'Name', render: (c: any) => <><div className="font-medium">{c.name}</div><div className="text-xs text-slate-500">{c.phone}</div></> },
        { key: 'gstin', label: 'GSTIN', render: (c: any) => c.gstin ?? <span className="text-slate-400">unregistered</span> },
        { key: 'sites', label: 'Sites', render: (c: any) => <>{c.sites.map((s: any) => s.name).join(', ') || '—'} <button className="ml-1 text-xs text-brand-600" onClick={() => setSiteFor(c)}>+ site</button></> },
        { key: 'credit', label: 'Credit', align: 'right', render: (c: any) => `${money(c.creditLimit)} · ${c.creditDays}d` },
      ]} />
      <Modal title="Add customer" open={open} onClose={() => setOpen(false)}>
        <CustomerForm onSaved={() => setOpen(false)} />
      </Modal>
      <Modal title={`New site for ${siteFor?.name ?? ''}`} open={!!siteFor} onClose={() => setSiteFor(null)}>
        <form className="grid grid-cols-2 gap-4" onSubmit={(e) => saveSite.mutate(formData(e))}>
          <Field label="Site name" className="col-span-2"><input name="name" className="input" required /></Field>
          <Field label="Address" className="col-span-2"><input name="address" className="input" /></Field>
          <Field label="City"><input name="city" className="input" /></Field>
          <Field label="PIN code (for e-way bills)"><input name="pincode" className="input" inputMode="numeric" pattern="[1-9][0-9]{5}" maxLength={6} title="6-digit PIN code" /></Field>
          <Field label="State code"><input name="stateCode" className="input" maxLength={2} defaultValue={siteFor?.stateCode} required /></Field>
          <Field label="Contact"><input name="contact" className="input" /></Field>
          <Field label="Latitude"><input name="lat" type="number" step="any" className="input" /></Field>
          <Field label="Longitude"><input name="lng" type="number" step="any" className="input" /></Field>
          <div className="col-span-2 flex justify-end"><button className="btn-primary" disabled={saveSite.isPending}>Save site</button></div>
        </form>
        <ErrorText error={saveSite.error} />
      </Modal>
    </>
  );
}
