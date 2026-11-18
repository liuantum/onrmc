import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, date, money } from '../lib/api';
import { ErrorText, Field, Modal, PageHeader, Stat, Table, formData, useSave } from '../components/ui';

const TABS = ['Receivables', 'Payables', 'Ledgers', 'Day book', 'Profit & loss', 'Balance sheet', 'Trial balance', 'GST'] as const;

export default function Accounts() {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Receivables');
  const [expense, setExpense] = useState(false);
  return (
    <>
      <PageHeader title="Accounts" subtitle="Double-entry books, posted automatically from billing, purchases and payments" actions={<button className="btn-primary" onClick={() => setExpense(true)}>Add expense</button>} />
      <div className="mb-5 flex flex-wrap gap-1 border-b border-slate-200">
        {TABS.map((t) => <button key={t} onClick={() => setTab(t)} className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${tab === t ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>{t}</button>)}
      </div>
      {tab === 'Receivables' && <Receivables />}
      {tab === 'Payables' && <Payables />}
      {tab === 'Ledgers' && <Ledgers />}
      {tab === 'Day book' && <DayBook />}
      {tab === 'Profit & loss' && <PL />}
      {tab === 'Balance sheet' && <BS />}
      {tab === 'Trial balance' && <TB />}
      {tab === 'GST' && <Gst />}
      {expense && <Expense onClose={() => setExpense(false)} />}
    </>
  );
}

function Receivables() {
  const { data } = useQuery({ queryKey: ['receivables'], queryFn: () => api('/accounts/receivables') });
  const total = data?.reduce((s: number, r: any) => s + r.total, 0) ?? 0;
  const over = data?.reduce((s: number, r: any) => s + r.d60 + r.d90 + r.over90, 0) ?? 0;
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4"><Stat label="Outstanding" value={money(total)} tone="amber" /><Stat label="Overdue 30+ days" value={money(over)} tone="red" /></div>
      <Table rows={data?.map((r: any) => ({ ...r, id: r.customer.id }))} cols={[
        { key: 'c', label: 'Customer', render: (r: any) => <><div className="font-medium">{r.customer.name}</div><div className="text-xs text-slate-500">{r.customer.phone}</div></> },
        { key: 'current', label: 'Not due', align: 'right', render: (r: any) => money(r.current) },
        { key: 'd30', label: '1–30', align: 'right', render: (r: any) => money(r.d30) },
        { key: 'd60', label: '31–60', align: 'right', render: (r: any) => money(r.d60) },
        { key: 'd90', label: '61–90', align: 'right', render: (r: any) => money(r.d90) },
        { key: 'credit', label: 'Credit notes', align: 'right', render: (r: any) => (r.credit ? <span className="text-emerald-700">−{money(r.credit)}</span> : '') },
        { key: 'over90', label: '90+', align: 'right', render: (r: any) => <span className={r.over90 ? 'font-semibold text-red-600' : ''}>{money(r.over90)}</span> },
        { key: 'total', label: 'Total', align: 'right', render: (r: any) => <b>{money(r.total)}</b> },
      ]} empty="No outstanding invoices 🎉" />
    </>
  );
}

function Ledgers() {
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: () => api('/accounts') });
  const [id, setId] = useState('');
  const { data: led } = useQuery({ queryKey: ['ledger', id], queryFn: () => api(`/accounts/${id}/ledger`), enabled: !!id });
  const groups = [...new Set<string>(accounts?.map((a: any) => a.group) ?? [])];
  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <div className="card max-h-[70vh] overflow-y-auto p-2">
        {groups.map((g) => (
          <div key={g} className="mb-2">
            <div className="px-2 py-1 text-xs font-semibold uppercase text-slate-400">{g}</div>
            {accounts.filter((a: any) => a.group === g).map((a: any) => (
              <button key={a.id} onClick={() => setId(a.id)} className={`flex w-full justify-between rounded px-2 py-1.5 text-sm ${id === a.id ? 'bg-brand-50 text-brand-700' : 'hover:bg-slate-50'}`}>
                <span className="truncate">{a.name}</span><span className="tabular-nums text-slate-500">{money(Math.abs(a.balance))} {a.balance >= 0 ? 'Dr' : 'Cr'}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
      <div>
        {!id && <div className="card p-10 text-center text-slate-400">Pick a ledger to see its statement</div>}
        {led && (
          <>
            <div className="mb-2 flex justify-between text-sm"><b>{led.account.name}</b><span>Opening {money(led.opening)}</span></div>
            <Table rows={led.rows} cols={[
              { key: 'date', label: 'Date', render: (r: any) => date(r.date) },
              { key: 'narration', label: 'Particulars' },
              { key: 'debit', label: 'Debit', align: 'right', render: (r: any) => (r.debit ? money(r.debit) : '') },
              { key: 'credit', label: 'Credit', align: 'right', render: (r: any) => (r.credit ? money(r.credit) : '') },
              { key: 'balance', label: 'Balance', align: 'right', render: (r: any) => `${money(Math.abs(r.balance))} ${r.balance >= 0 ? 'Dr' : 'Cr'}` },
            ]} />
          </>
        )}
      </div>
    </div>
  );
}

function DayBook() {
  const { data } = useQuery({ queryKey: ['daybook'], queryFn: () => api('/accounts/daybook') });
  return <Table rows={data} cols={[
    { key: 'date', label: 'Date', render: (j: any) => date(j.date) },
    { key: 'narration', label: 'Narration' },
    { key: 'e', label: 'Entries', render: (j: any) => j.entries.map((e: any) => <div key={e.id} className="text-xs">{Number(e.debit) ? 'Dr' : 'Cr'} {e.account.name} {money(Number(e.debit) || Number(e.credit))}</div>) },
  ]} />;
}

function PL() {
  const { data } = useQuery({ queryKey: ['pl'], queryFn: () => api('/accounts/profit-loss') });
  if (!data) return null;
  const line = (k: string, v: number, cls = '') => <div key={k} className={`flex justify-between py-1 ${cls}`}><span>{k}</span><span className="tabular-nums">{money(v)}</span></div>;
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Sales" value={money(data.income)} tone="blue" />
        <Stat label="Direct costs" value={money(data.materials + data.directExpenses)} hint={`Materials ${money(data.materials)} · diesel & other ${money(data.directExpenses)}`} />
        <Stat label="Gross profit" value={money(data.grossProfit)} hint={data.income ? `${((data.grossProfit / data.income) * 100).toFixed(1)}% of sales` : ''} tone={data.grossProfit >= 0 ? 'green' : 'red'} />
        <Stat label="Net profit" value={money(data.net)} tone={data.net >= 0 ? 'green' : 'red'} />
      </div>
      <div className="card max-w-2xl p-5 text-sm">
        <div className="label">Sales</div>
        {data.sales.map((r: any) => line(r.name, r.amount, 'pl-3'))}
        {line('Total sales', data.income, 'border-t border-slate-200 font-medium')}
        {line('Less: Cost of materials consumed', -data.materials, 'text-slate-600')}
        {data.direct.map((r: any) => line(`Less: ${r.name}`, -r.amount, 'text-slate-600'))}
        {line('Gross profit', data.grossProfit, 'border-t border-slate-300 font-semibold')}
        <div className="label mt-3">Expenses</div>
        {data.expenses.length === 0 && <div className="py-1 pl-3 text-slate-400">No other expenses booked</div>}
        {data.expenses.map((r: any) => line(r.name, -r.amount, 'pl-3'))}
        {line('Net profit', data.net, 'border-t-2 border-slate-400 text-base font-semibold')}
      </div>
      <p className="mt-2 text-xs text-slate-500">From {date(data.from)} (start of financial year) to today. Materials are costed at weighted average when each batch is recorded.</p>
    </>
  );
}

function BS() {
  const { data } = useQuery({ queryKey: ['bs'], queryFn: () => api('/accounts/balance-sheet') });
  if (!data) return null;
  const rows = (rs: any[]) => rs.map((r) => <div key={r.code} className="flex justify-between py-0.5 pl-3"><span>{r.name}</span><span className="tabular-nums">{money(r.amount)}</span></div>);
  const ok = Math.abs(data.totalAssets - data.totalLiabilitiesAndEquity) < 0.01;
  return (
    <>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="card p-5 text-sm">
          <div className="label">Liabilities</div>{rows(data.liabilities)}
          <div className="label mt-3">Capital &amp; reserves</div>{rows(data.equity)}
          <div className="flex justify-between py-0.5 pl-3"><span>Profit to date</span><span className="tabular-nums">{money(data.profitToDate)}</span></div>
          <div className="mt-2 flex justify-between border-t border-slate-300 pt-1 font-semibold"><span>Total</span><span className="tabular-nums">{money(data.totalLiabilitiesAndEquity)}</span></div>
        </div>
        <div className="card p-5 text-sm">
          <div className="label">Assets</div>{rows(data.assets)}
          <div className="mt-2 flex justify-between border-t border-slate-300 pt-1 font-semibold"><span>Total</span><span className="tabular-nums">{money(data.totalAssets)}</span></div>
        </div>
      </div>
      <div className={`mt-3 text-sm ${ok ? 'text-emerald-700' : 'text-red-600'}`}>{ok ? 'Balanced.' : 'Not balanced — check manual journals.'}</div>
      <div className={`mt-1 text-sm ${Math.abs(data.inventory.difference) < 1 ? 'text-slate-500' : 'text-amber-700'}`}>
        Inventory in books {money(data.inventory.ledger)} · stock valuation (qty × weighted average cost) {money(data.inventory.stockValuation)}{Math.abs(data.inventory.difference) >= 0.01 && ` · difference ${money(data.inventory.difference)}`}
      </div>
    </>
  );
}

function TB() {
  const { data } = useQuery({ queryKey: ['tb'], queryFn: () => api('/accounts/trial-balance') });
  if (!data) return null;
  return (
    <>
      <Table rows={data.rows} cols={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Account' }, { key: 'group', label: 'Group' }, { key: 'debit', label: 'Debit', align: 'right', render: (r: any) => (r.debit ? money(r.debit) : '') }, { key: 'credit', label: 'Credit', align: 'right', render: (r: any) => (r.credit ? money(r.credit) : '') }]} />
      <div className={`mt-2 text-right text-sm font-semibold ${Math.abs(data.totalDebit - data.totalCredit) < 0.01 ? 'text-emerald-700' : 'text-red-600'}`}>Totals: {money(data.totalDebit)} / {money(data.totalCredit)}</div>
    </>
  );
}

function Payables() {
  const { data } = useQuery({ queryKey: ['payables'], queryFn: () => api('/payables') });
  const total = data?.reduce((s: number, r: any) => s + r.ledger, 0) ?? 0;
  const overdue = data?.reduce((s: number, r: any) => s + r.d30 + r.d60 + r.d90 + r.over90, 0) ?? 0;
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4"><Stat label="Owed to suppliers" value={money(total)} tone="amber" /><Stat label="Bills overdue" value={money(overdue)} tone="red" /></div>
      <Table rows={data?.map((r: any) => ({ ...r, id: r.supplier.id }))} cols={[
        { key: 's', label: 'Supplier', render: (r: any) => r.supplier.name },
        { key: 'current', label: 'Not due', align: 'right', render: (r: any) => money(r.current) },
        { key: 'd30', label: '1–30', align: 'right', render: (r: any) => money(r.d30) },
        { key: 'd60', label: '31–60', align: 'right', render: (r: any) => money(r.d60) },
        { key: 'd90', label: '61–90', align: 'right', render: (r: any) => money(r.d90) },
        { key: 'over90', label: '90+', align: 'right', render: (r: any) => <span className={r.over90 ? 'font-semibold text-red-600' : ''}>{money(r.over90)}</span> },
        { key: 'u', label: 'Not on bills', align: 'right', render: (r: any) => (Math.abs(r.unallocated) > 0.009 ? <span className="text-slate-500" title="Opening balances, receipts posted before bills, advances">{money(r.unallocated)}</span> : '') },
        { key: 'ledger', label: 'Ledger balance', align: 'right', render: (r: any) => <b>{money(r.ledger)}</b> },
      ]} />
    </>
  );
}

function Gst() {
  const { data } = useQuery({ queryKey: ['gst'], queryFn: () => api('/accounts/gst-summary') });
  if (!data) return null;
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-5">
        <Stat label="Taxable (net of notes)" value={money(data.taxable)} hint={`${data.creditNotes} credit · ${data.debitNotes} debit notes`} /><Stat label="CGST" value={money(data.cgst)} /><Stat label="SGST" value={money(data.sgst)} /><Stat label="IGST" value={money(data.igst)} /><Stat label="B2B / B2C" value={`${data.b2b} / ${data.b2c}`} />
      </div>
      <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Input tax credit" value={money(data.itc.regular.cgst + data.itc.regular.sgst + data.itc.regular.igst)} hint={`${data.itc.regular.bills} bills, net of ${data.itc.regular.debitNotes} supplier debit notes`} tone="green" />
        <Stat label="Reverse charge GST (pay + claim)" value={money(data.itc.reverseCharge.cgst + data.itc.reverseCharge.sgst + data.itc.reverseCharge.igst)} hint={`${data.itc.reverseCharge.bills} bills`} />
        <Stat label="Output GST" value={money(data.cgst + data.sgst + data.igst)} />
        <Stat label="Net GST payable (est.)" value={money(data.cgst + data.sgst + data.igst - (data.itc.regular.cgst + data.itc.regular.sgst + data.itc.regular.igst))} hint="Output − regular ITC; RCM is paid in cash and claimed back" tone="amber" />
      </div>
      <Table rows={data.invoices.map((i: any) => ({ ...i, id: i.number }))} cols={[
        { key: 'number', label: 'Document', render: (i: any) => <>{i.number}{i.against && <div className="text-xs text-slate-500">{i.docType === 'CRN' ? 'Credit note' : 'Debit note'} vs {i.against}</div>}</> }, { key: 'd', label: 'Date', render: (i: any) => date(i.date) }, { key: 'customer', label: 'Customer' }, { key: 'gstin', label: 'GSTIN' }, { key: 'pos', label: 'POS' },
        { key: 'taxable', label: 'Taxable', align: 'right', render: (i: any) => money(i.taxable) }, { key: 'tax', label: 'Tax', align: 'right', render: (i: any) => money(i.cgst + i.sgst + i.igst) }, { key: 'total', label: 'Total', align: 'right', render: (i: any) => money(i.total) },
      ]} />
    </>
  );
}

function Expense({ onClose }: { onClose: () => void }) {
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: () => api('/accounts') });
  const save = useSave('/accounts/expenses', ['accounts', 'daybook', 'pl', 'tb'], onClose);
  return (
    <Modal title="Add expense" open onClose={onClose}>
      <form className="grid grid-cols-2 gap-4" onSubmit={(e) => save.mutate(formData(e))}>
        <Field label="Expense head" className="col-span-2"><select name="expenseAccountId" className="input" required>{accounts?.filter((a: any) => a.type === 'EXPENSE').map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <Field label="Amount (₹)"><input name="amount" type="number" step="0.01" className="input" required /></Field>
        <Field label="Paid from"><select name="paidFrom" className="input"><option value="CASH">Cash</option><option value="BANK">Bank</option></select></Field>
        <Field label="Narration" className="col-span-2"><input name="narration" className="input" required placeholder="e.g. Diesel for TS09UA1234" /></Field>
        <div className="col-span-2 flex justify-end"><button className="btn-primary" disabled={save.isPending}>Save</button></div>
      </form>
      <ErrorText error={save.error} />
    </Modal>
  );
}
