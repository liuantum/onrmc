import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api, date, money } from '../lib/api';
import { ErrorText, Field, Modal, PageHeader, Table, formData, useSave } from '../components/ui';

export default function Suppliers() {
  const { data } = useQuery({ queryKey: ['suppliers'], queryFn: () => api('/suppliers') });
  const [open, setOpen] = useState(false);
  const [ledger, setLedger] = useState<any>(null);
  return (
    <>
      <PageHeader title="Suppliers" subtitle="Balance = what you owe (from the supplier's ledger)" actions={<button className="btn-primary" onClick={() => setOpen(true)}><Plus size={16} />Add supplier</button>} />
      <Table rows={data} onRow={setLedger} cols={[
        { key: 'name', label: 'Supplier', render: (s: any) => <><div className="font-medium">{s.name}</div><div className="text-xs text-slate-500">{s.phone}</div></> },
        { key: 'gstin', label: 'GSTIN', render: (s: any) => s.gstin ?? <span className="text-xs text-amber-700">unregistered{s.rcmDefault ? ' · RCM' : ''}</span> },
        { key: 'st', label: 'State', render: (s: any) => s.stateCode ?? '—' },
        { key: 'terms', label: 'Terms', render: (s: any) => `${s.paymentTermsDays} days` },
        { key: 'bal', label: 'Balance', align: 'right', render: (s: any) => <span className={s.balance > 0 ? 'font-medium' : 'text-slate-400'}>{money(s.balance)}</span> },
      ]} />
      {open && <SupplierForm onClose={() => setOpen(false)} />}
      {ledger && <Ledger s={ledger} onClose={() => setLedger(null)} />}
    </>
  );
}

function SupplierForm({ onClose }: { onClose: () => void }) {
  const save = useSave('/suppliers', ['suppliers'], onClose);
  return (
    <Modal title="Add supplier" open onClose={onClose}>
      <form className="grid grid-cols-2 gap-4" onSubmit={(e) => { const d = formData(e); save.mutate({ ...d, rcmDefault: !!d.rcmDefault }); }}>
        <Field label="Name" className="col-span-2"><input name="name" className="input" required /></Field>
        <Field label="GSTIN (blank if unregistered)"><input name="gstin" className="input uppercase" maxLength={15} /></Field>
        <Field label="State code (if no GSTIN)"><input name="stateCode" className="input" maxLength={2} /></Field>
        <Field label="Address" className="col-span-2"><input name="address" className="input" /></Field>
        <Field label="City"><input name="city" className="input" /></Field>
        <Field label="PIN code"><input name="pincode" className="input" maxLength={6} /></Field>
        <Field label="Phone"><input name="phone" className="input" /></Field>
        <Field label="Payment terms (days)"><input name="paymentTermsDays" type="number" className="input" defaultValue={30} /></Field>
        <Field label="Opening balance owed (₹)"><input name="openingBalance" type="number" step="0.01" className="input" defaultValue={0} /></Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm"><input name="rcmDefault" type="checkbox" />Reverse charge by default (unregistered / GTA)</label>
        <div className="col-span-2 flex justify-end"><button className="btn-primary" disabled={save.isPending}>Save</button></div>
      </form>
      <ErrorText error={save.error} />
    </Modal>
  );
}

function Ledger({ s, onClose }: { s: any; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ['ledger', s.accountId], queryFn: () => api(`/accounts/${s.accountId}/ledger`), enabled: !!s.accountId });
  return (
    <Modal title={`${s.name} — ledger`} open onClose={onClose} wide>
      {!data ? <p className="text-sm text-slate-400">Loading…</p> : (
        <div className="max-h-[60vh] overflow-y-auto text-sm">
          <table className="w-full">
            <thead className="bg-slate-50"><tr><th className="th">Date</th><th className="th">Particulars</th><th className="th text-right">Debit</th><th className="th text-right">Credit</th><th className="th text-right">Balance (Cr)</th></tr></thead>
            <tbody>
              <tr><td className="td" colSpan={4}>Opening</td><td className="td text-right">{money(-data.opening)}</td></tr>
              {data.rows.map((r: any, i: number) => <tr key={i}><td className="td">{date(r.date)}</td><td className="td">{r.narration}</td><td className="td text-right">{r.debit ? money(r.debit) : ''}</td><td className="td text-right">{r.credit ? money(r.credit) : ''}</td><td className="td text-right tabular-nums">{money(-r.balance)}</td></tr>)}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
