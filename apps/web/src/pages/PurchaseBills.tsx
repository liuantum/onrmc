import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
import { api, date, money, qty } from '../lib/api';
import { Badge, ErrorText, Field, Modal, PageHeader, Table, useSave } from '../components/ui';

const PSTATUS: Record<string, string> = { OPEN: 'ISSUED', PARTIALLY_PAID: 'PARTIALLY_PAID', PAID: 'PAID', CANCELLED: 'CANCELLED' };
const due = (b: any) => Number(b.payable) - Number(b.paid) - Number(b.debitNoted);

export default function PurchaseBills() {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const { data } = useQuery({ queryKey: ['purchase-bills'], queryFn: () => api('/purchase-bills') });
  return (
    <>
      <PageHeader title="Purchase bills" subtitle="Supplier bills matched to goods receipts, or direct expense bills" actions={<button className="btn-primary" onClick={() => setOpen(true)}><Plus size={16} />Enter bill</button>} />
      <Table rows={data} onRow={(b: any) => nav(`/purchase-bills/${b.id}`)} empty="No supplier bills yet" cols={[
        { key: 'number', label: 'Number' },
        { key: 's', label: 'Supplier', render: (b: any) => <>{b.supplier.name}<div className="text-xs text-slate-500">#{b.supplierBillNo}</div></> },
        { key: 'k', label: 'Type', render: (b: any) => (b.kind === 'MATERIAL' ? 'Material' : 'Expense') + (b.rcm ? ' · RCM' : '') },
        { key: 'd', label: 'Bill date', render: (b: any) => date(b.billDate) },
        { key: 'due', label: 'Due', render: (b: any) => date(b.dueDate) },
        { key: 't', label: 'Bill total', align: 'right', render: (b: any) => money(b.total) },
        { key: 'bal', label: 'Balance', align: 'right', render: (b: any) => money(due(b)) },
        { key: 'st', label: 'Status', render: (b: any) => <Badge s={PSTATUS[b.status]} /> },
      ]} />
      {open && <NewBill onClose={() => setOpen(false)} />}
    </>
  );
}

type Line = { materialId?: string; expenseAccountId?: string; description?: string; hsn?: string; quantity: number; rate: number; gstRate: number };

function NewBill({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const { data: suppliers } = useQuery({ queryKey: ['suppliers'], queryFn: () => api('/suppliers') });
  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: () => api('/accounts') });
  const [h, setH] = useState<any>({ kind: 'MATERIAL', billDate: new Date().toLocaleDateString('en-CA'), tdsRate: 0, tcsAmount: 0 });
  const sup = suppliers?.find((s: any) => s.id === h.supplierId);
  const { data: grns } = useQuery({ queryKey: ['receipts', 'unbilled', h.supplierId], queryFn: () => api(`/receipts?unbilled=1&supplierId=${h.supplierId}`), enabled: !!h.supplierId && h.kind === 'MATERIAL' });
  const [picked, setPicked] = useState<string[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  useEffect(() => { setH((x: any) => ({ ...x, rcm: sup?.rcmDefault ?? false })); }, [sup?.id]);
  // material bills start from the GRN quantities and rates; the user changes them to match the paper bill
  useEffect(() => {
    if (h.kind !== 'MATERIAL') return;
    const agg = new Map<string, Line & { name: string }>();
    for (const g of grns?.filter((r: any) => picked.includes(r.id)) ?? []) for (const l of g.lines) {
      const a = agg.get(l.materialId) ?? { materialId: l.materialId, name: l.material.name, quantity: 0, rate: Number(l.rate), gstRate: 18 };
      a.quantity += Number(l.quantity); agg.set(l.materialId, a);
    }
    setLines([...agg.values()].map(({ name, ...l }) => ({ ...l, description: name })));
  }, [picked.join(','), grns, h.kind]);
  const body = { ...h, billDate: new Date(h.billDate).toISOString(), receiptIds: h.kind === 'MATERIAL' ? picked : [], lines, supplierTotal: h.supplierTotal || undefined, tdsSection: h.tdsSection || undefined };
  const preview = useMutation({ mutationFn: () => api('/purchase-bills/preview', { method: 'POST', body }) });
  const save = useSave('/purchase-bills', ['purchase-bills', 'receipts', 'suppliers', 'materials'], (b) => nav(`/purchase-bills/${b.id}`));
  const expenseAccs = accounts?.filter((a: any) => a.type === 'EXPENSE' && a.code !== '5000') ?? [];
  const setLine = (i: number, k: keyof Line, v: string) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: ['quantity', 'rate', 'gstRate'].includes(k) ? Number(v) : v } : l)));
  return (
    <Modal title="Enter supplier bill" open onClose={onClose} wide>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Field label="Supplier"><select className="input" value={h.supplierId ?? ''} onChange={(e) => { setH({ ...h, supplierId: e.target.value }); setPicked([]); }}><option value="">Select</option>{suppliers?.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Type"><select className="input" value={h.kind} onChange={(e) => { setH({ ...h, kind: e.target.value }); setPicked([]); setLines(e.target.value === 'EXPENSE' ? [{ quantity: 1, rate: 0, gstRate: 18 }] : []); }}><option value="MATERIAL">Material (against GRNs)</option><option value="EXPENSE">Expense / service</option></select></Field>
        <Field label="Supplier bill no."><input className="input" value={h.supplierBillNo ?? ''} onChange={(e) => setH({ ...h, supplierBillNo: e.target.value })} /></Field>
        <Field label="Bill date"><input className="input" type="date" value={h.billDate} onChange={(e) => setH({ ...h, billDate: e.target.value })} /></Field>
      </div>
      {h.kind === 'MATERIAL' && h.supplierId && (
        <div className="mt-3">
          <div className="label">Goods receipts to bill</div>
          <div className="max-h-40 overflow-y-auto rounded-lg border border-slate-200">
            {grns?.length === 0 && <div className="p-3 text-sm text-slate-400">No unbilled receipts from this supplier.</div>}
            {grns?.map((g: any) => (
              <label key={g.id} className="flex items-center gap-3 border-b border-slate-100 px-3 py-1.5 text-sm last:border-0">
                <input type="checkbox" checked={picked.includes(g.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, g.id] : picked.filter((x) => x !== g.id))} />
                <span className="w-32">{g.number}</span><span className="flex-1 text-slate-600">{g.lines.map((l: any) => `${l.material.name} ${qty(l.quantity)} @ ${l.rate}`).join(', ')}</span><span>{date(g.receivedAt)}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="mt-3">
        <div className="label">Bill lines (as printed on the supplier's bill)</div>
        <div className="space-y-2">
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-[1fr_80px_100px_90px_70px_32px] gap-2">
              {h.kind === 'MATERIAL' ? <input className="input bg-slate-50" value={l.description} readOnly />
                : <div className="grid grid-cols-2 gap-2"><select className="input" value={l.expenseAccountId ?? ''} onChange={(e) => setLine(i, 'expenseAccountId', e.target.value)}><option value="">Expense account</option>{expenseAccs.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</select><input className="input" placeholder="Description" value={l.description ?? ''} onChange={(e) => setLine(i, 'description', e.target.value)} /></div>}
              <input className="input" placeholder="HSN/SAC" value={l.hsn ?? ''} onChange={(e) => setLine(i, 'hsn', e.target.value)} />
              <input className="input" type="number" placeholder="Qty" value={l.quantity} onChange={(e) => setLine(i, 'quantity', e.target.value)} />
              <input className="input" type="number" step="0.0001" placeholder="Rate" value={l.rate} onChange={(e) => setLine(i, 'rate', e.target.value)} />
              <select className="input" value={l.gstRate} onChange={(e) => setLine(i, 'gstRate', e.target.value)}>{[0, 5, 12, 18, 28].map((r) => <option key={r} value={r}>{r}%</option>)}</select>
              {h.kind === 'EXPENSE' ? <button className="btn-ghost p-2" onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 size={16} /></button> : <span />}
            </div>
          ))}
          {h.kind === 'EXPENSE' && <button className="text-sm text-brand-600" onClick={() => setLines([...lines, { quantity: 1, rate: 0, gstRate: 18 }])}>+ Add line</button>}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-5">
        <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={!!h.rcm} onChange={(e) => setH({ ...h, rcm: e.target.checked })} />Reverse charge</label>
        <Field label="TDS section"><input className="input" placeholder="194C / 194Q" value={h.tdsSection ?? ''} onChange={(e) => setH({ ...h, tdsSection: e.target.value })} /></Field>
        <Field label="TDS %"><input className="input" type="number" step="0.01" value={h.tdsRate} onChange={(e) => setH({ ...h, tdsRate: Number(e.target.value) })} /></Field>
        <Field label="TCS charged (₹)"><input className="input" type="number" step="0.01" value={h.tcsAmount} onChange={(e) => setH({ ...h, tcsAmount: Number(e.target.value) })} /></Field>
        <Field label="Bill total on paper (₹)"><input className="input" type="number" step="0.01" value={h.supplierTotal ?? ''} onChange={(e) => setH({ ...h, supplierTotal: e.target.value ? Number(e.target.value) : undefined })} /></Field>
      </div>
      {preview.data && (
        <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm">
          {preview.data.lines.filter((l: any) => l.variance).map((l: any) => (
            <div key={l.materialId} className={`flex justify-between ${l.variance.qty || l.variance.rate ? 'text-amber-800' : 'text-slate-600'}`}>
              <span>{l.description}: billed {qty(l.quantity)} vs received {qty(l.grnQty)}{l.variance.qty ? ` (${l.variance.qty > 0 ? '+' : ''}${qty(l.variance.qty)})` : ''} · rate {l.variance.rate ? `${l.variance.rate > 0 ? '+' : ''}${l.variance.rate}` : 'matches'}</span>
              <span>{l.claimValue ? `claim ${money(l.claimValue)} · ` : ''}stock revalued {money(l.inventoryAdj)}</span>
            </div>
          ))}
          <div className="mt-1 flex justify-between"><span>Taxable</span><span>{money(preview.data.taxable)}</span></div>
          <div className="flex justify-between"><span>{preview.data.interState ? 'IGST' : 'CGST + SGST'}{preview.data.rcm ? ' (reverse charge — you pay it)' : ''}</span><span>{money(preview.data.cgst + preview.data.sgst + preview.data.igst)}</span></div>
          <div className="flex justify-between font-semibold"><span>Bill total</span><span>{money(preview.data.total)}</span></div>
          <div className="flex justify-between text-slate-600"><span>Payable to supplier (after TDS {money(preview.data.tdsAmount)}, TCS)</span><span>{money(preview.data.payable)}</span></div>
        </div>
      )}
      <ErrorText error={(preview.error as Error | null)?.message ?? null} />
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-ghost" disabled={!h.supplierId || !lines.length || preview.isPending} onClick={() => preview.mutate()}>Check & match</button>
        <button className="btn-primary" disabled={!h.supplierId || !h.supplierBillNo || !lines.length || save.isPending} onClick={() => save.mutate(body)}>Save bill</button>
      </div>
      <ErrorText error={save.error} />
    </Modal>
  );
}

export function PurchaseBillView() {
  const { id } = useParams();
  const { data: b } = useQuery({ queryKey: ['purchase-bills', id], queryFn: () => api(`/purchase-bills/${id}`) });
  const [dn, setDn] = useState(false);
  const [cancel, setCancel] = useState(false);
  const [reason, setReason] = useState('');
  const cancelSave = useSave(`/purchase-bills/${id}/cancel`, ['purchase-bills', 'receipts', 'suppliers'], () => setCancel(false));
  if (!b) return <div className="text-slate-400">Loading…</div>;
  const accName = (aid: string) => b.expenseAccounts.find((a: any) => a.id === aid)?.name;
  return (
    <>
      <PageHeader title={`${b.number} · ${b.supplier.name}`} subtitle={`Supplier bill #${b.supplierBillNo} dated ${date(b.billDate)} · due ${date(b.dueDate)}`} actions={<>
        <Badge s={PSTATUS[b.status]} />
        {b.status !== 'CANCELLED' && <button className="btn-ghost" onClick={() => setDn(true)}>Debit note</button>}
        {b.status !== 'CANCELLED' && Number(b.paid) === 0 && <button className="btn-danger" onClick={() => setCancel(true)}>Cancel bill</button>}
      </>} />
      <div className="card p-5">
        <table className="w-full text-sm">
          <thead className="bg-slate-50"><tr><th className="th">Item</th><th className="th text-right">Billed</th>{b.kind === 'MATERIAL' && <th className="th text-right">Received (GRN)</th>}<th className="th text-right">Rate</th><th className="th text-right">Taxable</th><th className="th text-right">GST</th>{b.kind === 'MATERIAL' && <th className="th text-right">Stock revalued</th>}{b.kind === 'MATERIAL' && <th className="th text-right">Short-supply claim</th>}</tr></thead>
          <tbody>{b.lines.map((l: any) => (
            <tr key={l.id} className="border-t border-slate-100">
              <td className="td">{l.description}<div className="text-xs text-slate-500">{l.materialId ? l.hsn : accName(l.expenseAccountId)}</div></td>
              <td className="td text-right">{qty(l.quantity, 3)} {l.unit}</td>
              {b.kind === 'MATERIAL' && <td className={`td text-right ${Number(l.quantity) !== Number(l.grnQty) ? 'text-amber-700' : ''}`}>{qty(l.grnQty, 3)}</td>}
              <td className="td text-right">{Number(l.rate)}</td><td className="td text-right">{money(l.taxable)}</td><td className="td text-right">{money(l.tax)}<div className="text-xs text-slate-400">{Number(l.gstRate)}%</div></td>
              {b.kind === 'MATERIAL' && <td className="td text-right">{money(l.inventoryAdj)}</td>}
              {b.kind === 'MATERIAL' && <td className="td text-right">{Number(l.claimValue) ? `${qty(l.claimQty, 3)} · ${money(l.claimValue)}` : '—'}</td>}
            </tr>
          ))}</tbody>
        </table>
        <div className="ml-auto mt-4 w-80 space-y-1 text-sm">
          <R k="Taxable" v={b.taxable} />{Number(b.cgst) > 0 && <R k="CGST" v={b.cgst} />}{Number(b.sgst) > 0 && <R k="SGST" v={b.sgst} />}{Number(b.igst) > 0 && <R k="IGST" v={b.igst} />}
          {b.rcm && <div className="text-xs text-amber-700">Reverse charge: GST is paid by you, not to the supplier</div>}
          {Number(b.roundOff) !== 0 && <R k="Round off" v={b.roundOff} />}
          <div className="flex justify-between border-t border-slate-300 pt-1 font-semibold"><span>Bill total</span><span>{money(b.total)}</span></div>
          {Number(b.tdsAmount) > 0 && <R k={`TDS ${b.tdsSection ?? ''} @ ${Number(b.tdsRate)}%`} v={-b.tdsAmount} />}
          {Number(b.tcsAmount) > 0 && <R k="TCS" v={b.tcsAmount} />}
          <R k="Payable" v={b.payable} /><R k="Debit notes" v={-b.debitNoted} /><R k="Paid" v={-b.paid} />
          <div className="flex justify-between font-semibold"><span>Balance</span><span>{money(b.due)}</span></div>
        </div>
        {b.status === 'CANCELLED' && <div className="mt-3 rounded bg-red-50 p-3 text-sm text-red-700">Cancelled: {b.cancelReason}</div>}
        <div className="mt-4 grid gap-4 text-sm md:grid-cols-3">
          <div><div className="label">Goods receipts</div>{b.receipts.map((r: any) => <div key={r.id}>{r.number} · {date(r.receivedAt)} · {money(r.amount)}</div>)}{!b.receipts.length && <span className="text-slate-400">—</span>}</div>
          <div><div className="label">Payments</div>{b.allocations.map((a: any) => <div key={a.id}>{a.payment.number} · {date(a.payment.paidAt)} · {money(a.amount)}</div>)}{!b.allocations.length && <span className="text-slate-400">—</span>}</div>
          <div><div className="label">Debit notes</div>{b.debitNotes.map((d: any) => <div key={d.id} className={d.status === 'CANCELLED' ? 'text-slate-400 line-through' : ''}>{d.number} · {d.reason.replace('_', ' ').toLowerCase()} · {money(d.total)}</div>)}{!b.debitNotes.length && <span className="text-slate-400">—</span>}</div>
        </div>
      </div>
      {dn && <DebitNote bill={b} onClose={() => setDn(false)} />}
      <Modal title="Cancel bill" open={cancel} onClose={() => setCancel(false)}>
        <p className="mb-3 text-sm text-slate-600">Reverses the postings and frees its goods receipts to be billed again.</p>
        <input className="input" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className="mt-4 flex justify-end"><button className="btn-danger" disabled={reason.trim().length < 5 || cancelSave.isPending} onClick={() => cancelSave.mutate({ reason: reason.trim() })}>Cancel bill</button></div>
        <ErrorText error={cancelSave.error} />
      </Modal>
    </>
  );
}

function DebitNote({ bill, onClose }: { bill: any; onClose: () => void }) {
  const [reason, setReason] = useState(bill.lines.some((l: any) => Number(l.claimQty) > 0) ? 'SHORT_SUPPLY' : 'RATE_DIFFERENCE');
  const [text, setText] = useState('');
  const [vals, setVals] = useState<Record<string, any>>({});
  const save = useSave('/supplier-debit-notes', ['purchase-bills', 'suppliers'], onClose);
  const lines = bill.lines.filter((l: any) => reason !== 'SHORT_SUPPLY' || Number(l.claimQty) > 0);
  const submit = () => save.mutate({ billId: bill.id, reason, reasonText: text || undefined, lines: Object.entries(vals).filter(([, v]) => v).map(([billLineId, v]) => ({ billLineId, ...(reason === 'SHORT_SUPPLY' ? { quantity: v } : reason === 'RATE_DIFFERENCE' ? { rate: v } : { amount: v }) })) });
  return (
    <Modal title={`Debit note to ${bill.supplier.name}`} open onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Reason"><select className="input" value={reason} onChange={(e) => { setReason(e.target.value); setVals({}); }}><option value="SHORT_SUPPLY">Short supply</option><option value="RATE_DIFFERENCE">Rate difference</option><option value="OTHER">Other (quality, damage)</option></select></Field>
        <Field label="Details"><input className="input" value={text} onChange={(e) => setText(e.target.value)} /></Field>
      </div>
      <div className="mt-3 space-y-2 text-sm">
        {lines.map((l: any) => (
          <div key={l.id} className="flex items-center justify-between gap-3">
            <span className="flex-1">{l.description}<span className="text-xs text-slate-500"> · {reason === 'SHORT_SUPPLY' ? `short ${qty(l.claimQty, 3)} ${l.unit}` : `billed ${qty(l.quantity, 3)} @ ${Number(l.rate)}`}</span></span>
            <input className="input w-32" type="number" step="0.0001" placeholder={reason === 'SHORT_SUPPLY' ? 'Qty' : reason === 'RATE_DIFFERENCE' ? '₹ less / unit' : 'Amount ₹'} value={vals[l.id] ?? ''} onChange={(e) => setVals({ ...vals, [l.id]: e.target.value ? Number(e.target.value) : undefined })} />
          </div>
        ))}
        {!lines.length && <p className="text-slate-400">Nothing was billed beyond what was received.</p>}
      </div>
      <p className="mt-2 text-xs text-slate-500">Input GST on the note is reversed; the note is set off against this bill's balance.</p>
      <div className="mt-4 flex justify-end"><button className="btn-primary" disabled={save.isPending || !Object.values(vals).some(Boolean)} onClick={submit}>Issue debit note</button></div>
      <ErrorText error={save.error} />
    </Modal>
  );
}
const R = ({ k, v }: { k: string; v: any }) => <div className="flex justify-between"><span className="text-slate-500">{k}</span><span className="tabular-nums">{money(v)}</span></div>;
