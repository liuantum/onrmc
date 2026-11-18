import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { computeLine, sumBreakups } from '@onrmc/shared';
import { api, date, money, qty } from '../lib/api';
import { Badge, ErrorText, Field, Modal, PageHeader, Table, useSave } from '../components/ui';

export const REASONS: Record<string, string> = {
  RATE_DIFFERENCE: 'Rate difference', QUANTITY_RETURNED: 'Quantity returned / rejected', SHORT_SUPPLY: 'Short supply',
  POST_SUPPLY_DISCOUNT: 'Discount after supply', IRN_CANCELLED_AFTER_24H: 'Full reversal (IRN older than 24 h)',
};

export default function Notes() {
  const nav = useNavigate();
  const [type, setType] = useState('');
  const { data } = useQuery({ queryKey: ['notes', type], queryFn: () => api(`/notes${type ? `?type=${type}` : ''}`) });
  return (
    <>
      <PageHeader title="Credit & debit notes" subtitle="Issued from an invoice (open the invoice → Credit note / Debit note)" />
      <div className="mb-3 flex items-center gap-2 text-sm">
        <select className="input w-44" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All notes</option><option value="CREDIT">Credit notes</option><option value="DEBIT">Debit notes</option>
        </select>
      </div>
      <Table rows={data} onRow={(n: any) => nav(`/notes/${n.id}`)} empty="No credit or debit notes yet" cols={[
        { key: 'number', label: 'Number' },
        { key: 'type', label: 'Type', render: (n: any) => (n.type === 'CREDIT' ? 'Credit note' : 'Debit note') },
        { key: 'inv', label: 'Against', render: (n: any) => n.invoice.number },
        { key: 'c', label: 'Customer', render: (n: any) => n.customer.name },
        { key: 'r', label: 'Reason', render: (n: any) => REASONS[n.reason] },
        { key: 'd', label: 'Date', render: (n: any) => date(n.issueDate) },
        { key: 't', label: 'Total', align: 'right', render: (n: any) => `${n.type === 'CREDIT' ? '−' : '+'}${money(n.total)}` },
        { key: 's', label: 'Status', render: (n: any) => <Badge s={n.status} /> },
        { key: 'e', label: 'E-invoice', render: (n: any) => (n.einvoiceStatus === 'NOT_REQUIRED' ? <span className="text-xs text-slate-400">—</span> : <Badge s={n.einvoiceStatus} />) },
      ]} />
    </>
  );
}

type Row = { invoiceLineId: string; description: string; unit: string; quantity: number; rate: number; gstRate: number; taxable: number; creditableTaxable: number; returnableQty: number };

/** Create a credit / debit note against one invoice. The server re-checks every limit. */
export function NoteForm({ invoice, type, onClose }: { invoice: any; type: 'CREDIT' | 'DEBIT'; onClose: () => void }) {
  const nav = useNavigate();
  const { data: limits } = useQuery({ queryKey: ['invoices', invoice.id, 'note-limits'], queryFn: () => api<Row[]>(`/invoices/${invoice.id}/note-limits`) });
  const reasons = type === 'DEBIT' ? ['RATE_DIFFERENCE'] : Object.keys(REASONS);
  const [reason, setReason] = useState(reasons[0]);
  const [reasonText, setReasonText] = useState('');
  const [vals, setVals] = useState<Record<string, { quantity?: number; rate?: number; amount?: number }>>({});
  const save = useSave('/notes', ['invoices', 'notes', 'challans'], (n) => nav(`/notes/${n.id}`));
  const gst = invoice.type === 'TAX_INVOICE';
  const qtyMode = reason === 'QUANTITY_RETURNED' || reason === 'SHORT_SUPPLY';
  const full = reason === 'IRN_CANCELLED_AFTER_24H';
  const set = (id: string, k: 'quantity' | 'rate' | 'amount', v: string) => setVals({ ...vals, [id]: { ...vals[id], [k]: v === '' ? undefined : Number(v) } });
  const picked = (limits ?? []).flatMap((l) => {
    const v = vals[l.invoiceLineId] ?? {};
    if (full) return [{ l, quantity: l.quantity, rate: l.rate }];
    if (qtyMode) return v.quantity ? [{ l, quantity: v.quantity, rate: l.rate }] : [];
    if (reason === 'RATE_DIFFERENCE') return v.rate ? [{ l, quantity: v.quantity ?? l.returnableQty, rate: v.rate }] : [];
    return v.amount ? [{ l, quantity: 1, rate: v.amount, amount: v.amount }] : [];
  });
  const preview = sumBreakups(picked.map((p) => computeLine({ quantity: p.quantity, rate: p.rate, gstRate: p.l.gstRate }, invoice.interState, gst)));
  const submit = () => save.mutate({
    invoiceId: invoice.id, type, reason, reasonText: reasonText || undefined,
    lines: full ? [] : picked.map((p: any) => ({ invoiceLineId: p.l.invoiceLineId, ...(qtyMode ? { quantity: p.quantity } : reason === 'RATE_DIFFERENCE' ? { quantity: p.quantity, rate: p.rate } : { amount: p.amount }) })),
  });
  return (
    <Modal title={`${type === 'CREDIT' ? 'Credit' : 'Debit'} note against ${invoice.number}`} open onClose={onClose} wide>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Reason"><select className="input" value={reason} onChange={(e) => { setReason(e.target.value); setVals({}); }}>{reasons.map((r) => <option key={r} value={r}>{REASONS[r]}</option>)}</select></Field>
        <Field label="Details (shown on the note)"><input className="input" value={reasonText} maxLength={200} onChange={(e) => setReasonText(e.target.value)} /></Field>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        {type === 'DEBIT' ? 'Debit notes raise the rate only — concrete quantity can never go above what was delivered.'
          : full ? 'Reverses the whole invoice. Use this when its IRN is more than 24 hours old and can no longer be cancelled.'
          : 'A credit note cannot exceed what is left of each line. Same GST rate and place of supply as the invoice.'}
      </p>
      <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50"><tr><th className="th">Line</th><th className="th text-right">Billed</th><th className="th text-right">{type === 'CREDIT' ? 'Left to credit' : 'Rate'}</th>
            {!full && <th className="th">{qtyMode ? 'Qty to credit' : reason === 'RATE_DIFFERENCE' ? 'Rate change / unit · qty' : 'Discount (taxable ₹)'}</th>}</tr></thead>
          <tbody>{limits?.map((l) => (
            <tr key={l.invoiceLineId} className="border-t border-slate-100">
              <td className="td">{l.description}</td>
              <td className="td text-right tabular-nums">{qty(l.quantity)} {l.unit} × {money(l.rate)}</td>
              <td className="td text-right tabular-nums">{type === 'CREDIT' ? <>{money(l.creditableTaxable)}<div className="text-xs text-slate-400">{qty(l.returnableQty)} {l.unit} returnable</div></> : money(l.rate)}</td>
              {!full && <td className="td">
                {qtyMode && <input className="input w-28" type="number" min={0} max={l.returnableQty} step="0.5" value={vals[l.invoiceLineId]?.quantity ?? ''} onChange={(e) => set(l.invoiceLineId, 'quantity', e.target.value)} />}
                {reason === 'RATE_DIFFERENCE' && <div className="flex gap-2">
                  <input className="input w-24" type="number" min={0} step="0.01" placeholder="₹/unit" value={vals[l.invoiceLineId]?.rate ?? ''} onChange={(e) => set(l.invoiceLineId, 'rate', e.target.value)} />
                  <input className="input w-24" type="number" min={0} max={l.returnableQty} step="0.5" placeholder={String(l.returnableQty)} value={vals[l.invoiceLineId]?.quantity ?? ''} onChange={(e) => set(l.invoiceLineId, 'quantity', e.target.value)} />
                </div>}
                {reason === 'POST_SUPPLY_DISCOUNT' && <input className="input w-32" type="number" min={0} step="0.01" value={vals[l.invoiceLineId]?.amount ?? ''} onChange={(e) => set(l.invoiceLineId, 'amount', e.target.value)} />}
              </td>}
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div className="mt-4 rounded-lg bg-slate-50 p-4 text-sm">
        <div className="flex justify-between"><span>Taxable value</span><span className="tabular-nums">{money(preview.taxable)}</span></div>
        {gst && <div className="flex justify-between text-slate-500"><span>GST ({invoice.interState ? 'IGST' : 'CGST + SGST'}, as on the invoice)</span><span className="tabular-nums">{money(preview.total - preview.taxable)}</span></div>}
        <div className="mt-1 flex justify-between font-semibold"><span>{type === 'CREDIT' ? 'Credit' : 'Debit'} total</span><span className="tabular-nums">{money(Math.round(preview.total))}</span></div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose}>Back</button>
        <button className="btn-primary" disabled={(!full && !picked.length) || save.isPending} onClick={submit}>Issue {type === 'CREDIT' ? 'credit' : 'debit'} note</button>
      </div>
      <ErrorText error={save.error} />
    </Modal>
  );
}
