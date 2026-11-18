import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api, date, money } from '../lib/api';
import { ErrorText, Field, Modal, PageHeader, Table, formData, useSave } from '../components/ui';

export default function SupplierPayments() {
  const { data } = useQuery({ queryKey: ['supplier-payments'], queryFn: () => api('/supplier-payments') });
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader title="Supplier payments" subtitle="Settles the oldest due bills first" actions={<button className="btn-primary" onClick={() => setOpen(true)}><Plus size={16} />Pay supplier</button>} />
      <Table rows={data} cols={[
        { key: 'number', label: 'Voucher' },
        { key: 's', label: 'Supplier', render: (p: any) => p.supplier.name },
        { key: 'd', label: 'Date', render: (p: any) => date(p.paidAt) },
        { key: 'm', label: 'Mode', render: (p: any) => `${p.mode.replace('_', ' ').toLowerCase()}${p.reference ? ` · ${p.reference}` : ''}` },
        { key: 'a', label: 'Against', render: (p: any) => p.allocations.map((a: any) => `${a.bill.number} (${money(a.amount)})`).join(', ') || <span className="text-slate-400">on account</span> },
        { key: 'amt', label: 'Amount', align: 'right', render: (p: any) => money(p.amount) },
      ]} />
      {open && <PayForm onClose={() => setOpen(false)} />}
    </>
  );
}

function PayForm({ onClose }: { onClose: () => void }) {
  const { data: suppliers } = useQuery({ queryKey: ['suppliers'], queryFn: () => api('/suppliers') });
  const [sid, setSid] = useState('');
  const { data: bills } = useQuery({ queryKey: ['purchase-bills', 'open', sid], queryFn: () => api(`/purchase-bills?supplierId=${sid}`), enabled: !!sid });
  const open = bills?.filter((b: any) => ['OPEN', 'PARTIALLY_PAID'].includes(b.status)) ?? [];
  const save = useSave('/supplier-payments', ['supplier-payments', 'purchase-bills', 'suppliers'], onClose);
  return (
    <Modal title="Pay supplier" open onClose={onClose}>
      <form className="grid grid-cols-2 gap-4" onSubmit={(e) => save.mutate(formData(e))}>
        <Field label="Supplier" className="col-span-2"><select name="supplierId" className="input" required value={sid} onChange={(e) => setSid(e.target.value)}><option value="">Select</option>{suppliers?.map((s: any) => <option key={s.id} value={s.id}>{s.name} — owe {money(s.balance)}</option>)}</select></Field>
        {sid && <div className="col-span-2 rounded-lg bg-slate-50 p-3 text-xs">{open.length ? open.map((b: any) => <div key={b.id} className="flex justify-between"><span>{b.number} · #{b.supplierBillNo} · due {date(b.dueDate)}</span><span className="tabular-nums">{money(Number(b.payable) - Number(b.paid) - Number(b.debitNoted))}</span></div>) : 'No open bills — the payment will sit on account.'}</div>}
        <Field label="Amount (₹)"><input name="amount" type="number" step="0.01" className="input" required /></Field>
        <Field label="Mode"><select name="mode" className="input"><option value="BANK_TRANSFER">Bank transfer</option><option value="UPI">UPI</option><option value="CHEQUE">Cheque</option><option value="CASH">Cash</option></select></Field>
        <Field label="Reference (UTR / cheque no.)" className="col-span-2"><input name="reference" className="input" /></Field>
        <div className="col-span-2 flex justify-end"><button className="btn-primary" disabled={save.isPending}>Record payment</button></div>
      </form>
      <ErrorText error={save.error} />
    </Modal>
  );
}
