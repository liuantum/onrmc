import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api, date, money } from '../lib/api';
import { ErrorText, Field, Modal, PageHeader, Table, formData, useSave } from '../components/ui';

export default function Payments() {
  const [open, setOpen] = useState(false);
  const { data } = useQuery({ queryKey: ['payments'], queryFn: () => api('/payments') });
  const { data: customers } = useQuery({ queryKey: ['customers'], queryFn: () => api('/customers') });
  const save = useSave('/payments', ['payments', 'invoices', 'dashboard', 'receivables'], () => setOpen(false));
  return (
    <>
      <PageHeader title="Payments received" actions={<button className="btn-primary" onClick={() => setOpen(true)}><Plus size={16} />Record payment</button>} />
      <Table rows={data} cols={[
        { key: 'number', label: 'Receipt' },
        { key: 'd', label: 'Date', render: (p: any) => date(p.receivedAt) },
        { key: 'c', label: 'Customer', render: (p: any) => p.customer.name },
        { key: 'm', label: 'Mode', render: (p: any) => `${p.mode.replace('_', ' ').toLowerCase()}${p.reference ? ` · ${p.reference}` : ''}` },
        { key: 'a', label: 'Settled invoices', render: (p: any) => p.allocations.map((a: any) => a.invoice.number).join(', ') || <span className="text-amber-600">on account</span> },
        { key: 'amt', label: 'Amount', align: 'right', render: (p: any) => money(p.amount) },
      ]} />
      <Modal title="Record payment" open={open} onClose={() => setOpen(false)}>
        <form className="grid grid-cols-2 gap-4" onSubmit={(e) => save.mutate(formData(e))}>
          <Field label="Customer" className="col-span-2"><select name="customerId" className="input" required><option value="">Select</option>{customers?.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="Amount (₹)"><input name="amount" type="number" step="0.01" className="input" required /></Field>
          <Field label="Mode"><select name="mode" className="input">{['UPI', 'BANK_TRANSFER', 'CHEQUE', 'CASH', 'CARD'].map((m) => <option key={m} value={m}>{m.replace('_', ' ').toLowerCase()}</option>)}</select></Field>
          <Field label="Reference / UTR / cheque no."><input name="reference" className="input" /></Field>
          <Field label="Date"><input name="receivedAt" type="date" className="input" defaultValue={new Date().toISOString().slice(0, 10)} /></Field>
          <p className="col-span-2 text-xs text-slate-500">The amount settles the oldest unpaid invoices first.</p>
          <div className="col-span-2 flex justify-end"><button className="btn-primary" disabled={save.isPending}>Save</button></div>
        </form>
        <ErrorText error={save.error} />
      </Modal>
    </>
  );
}
