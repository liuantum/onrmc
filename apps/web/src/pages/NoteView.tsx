import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { api, date, dateTime, money, qty } from '../lib/api';
import { DocFooter, DocLogo } from '../components/PrintBits';
import { Badge, ErrorText, Modal, PageHeader } from '../components/ui';
import { IRN_REASONS, Preview, QrImage, ReasonDialog, useAction } from './InvoiceView';
import { REASONS } from './Notes';

export default function NoteView() {
  const { id } = useParams();
  const { data: n } = useQuery({ queryKey: ['notes', id], queryFn: () => api(`/notes/${id}`) });
  const [dlg, setDlg] = useState<null | 'irn' | 'irnCancel' | 'cancel'>(null);
  const [reason, setReason] = useState('');
  const act = useAction('POST', () => setDlg(null));
  if (!n) return <div className="text-slate-400">Loading…</div>;
  const credit = n.type === 'CREDIT';
  const gst = n.invoice.type === 'TAX_INVOICE';
  const title = credit ? 'Credit Note' : 'Debit Note';
  const within24 = n.ackDate && Date.now() - new Date(n.ackDate).getTime() < 24 * 3600e3;
  const close = () => { setDlg(null); act.reset(); };
  return (
    <>
      <PageHeader title={n.number} subtitle={`${title} against ${n.invoice.number}`} actions={<>
        <Badge s={n.status} />
        <button className="btn-ghost" onClick={() => print()}><Printer size={16} />Print / PDF</button>
        {n.status === 'ISSUED' && n.einvoiceStatus !== 'GENERATED' && <button className="btn-danger" onClick={() => setDlg('cancel')}>Cancel note</button>}
      </>} />
      {n.einvoiceStatus !== 'NOT_REQUIRED' && (
        <div className="no-print card mx-auto mb-4 max-w-4xl p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm"><span className="font-medium">E-invoice ({credit ? 'CRN' : 'DBN'})</span><Badge s={n.einvoiceStatus} /></div>
            <div className="flex gap-2">
              {(n.einvoiceStatus === 'PENDING' || n.einvoiceStatus === 'FAILED') && n.status === 'ISSUED' && <button className="btn-primary" onClick={() => setDlg('irn')}>Generate IRN</button>}
              {n.einvoiceStatus === 'GENERATED' && within24 && <button className="btn-danger" onClick={() => setDlg('irnCancel')}>Cancel IRN</button>}
            </div>
          </div>
          {n.einvoiceStatus === 'FAILED' && n.einvoiceError && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{n.einvoiceError}</p>}
        </div>
      )}
      <div className="card mx-auto max-w-4xl p-8 print:border-0 print:shadow-none">
        <div className="flex justify-between border-b border-slate-200 pb-4">
          <div className="flex items-start gap-4">
            <DocLogo src={n.tenant.logoUrl} />
            <div>
            <div className="text-xl font-bold">{n.tenant.legalName ?? n.tenant.name}</div>
            <div className="text-sm text-slate-600">{n.tenant.address}</div>
            {n.tenant.gstin && <div className="text-sm">GSTIN: <b>{n.tenant.gstin}</b></div>}
            </div>
          </div>
          <div className="flex gap-4 text-right">
            <div>
              <div className="text-lg font-semibold uppercase tracking-wide">{title}</div>
              <div className="text-sm">No: <b>{n.number}</b></div>
              <div className="text-sm">Date: {date(n.issueDate)}</div>
              <div className="text-sm">Against invoice: <Link className="text-brand-600 print:text-inherit" to={`/invoices/${n.invoice.id}`}>{n.invoice.number}</Link> dt. {date(n.invoice.issueDate)}</div>
            </div>
            {n.einvoiceStatus === 'GENERATED' && n.signedQr && <QrImage text={n.signedQr} />}
          </div>
        </div>
        {n.irn && (
          <div className="border-b border-slate-200 py-2 text-xs leading-5">
            <div><span className="text-slate-500">IRN:</span> <span className="break-all font-mono">{n.irn}</span>{n.einvoiceStatus === 'CANCELLED' && <b className="ml-2 text-red-600">IRN CANCELLED</b>}</div>
            <div><span className="text-slate-500">Ack No:</span> {n.ackNo} · <span className="text-slate-500">Ack Date:</span> {n.ackDate && dateTime(n.ackDate)}</div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-4 border-b border-slate-200 py-4 text-sm">
          <div><div className="label">Customer</div><div className="font-semibold">{n.customer.name}</div><div>{n.customer.billingAddress}</div>{n.customer.gstin && <div>GSTIN: {n.customer.gstin}</div>}</div>
          <div className="text-right"><div className="label">Reason</div><div>{REASONS[n.reason]}</div>{n.reasonText && <div className="text-slate-500">{n.reasonText}</div>}<div className="label mt-2">Place of supply</div><div>State code {n.placeOfSupply}</div></div>
        </div>
        <table className="mt-4 w-full text-sm">
          <thead className="bg-slate-50"><tr><th className="th">#</th><th className="th">Description</th><th className="th">HSN/SAC</th><th className="th text-right">Qty</th><th className="th text-right">{n.reason === 'RATE_DIFFERENCE' ? 'Rate change' : 'Rate'}</th><th className="th text-right">Taxable</th>{gst && <th className="th text-right">GST</th>}<th className="th text-right">Amount</th></tr></thead>
          <tbody>{n.lines.map((l: any, i: number) => (
            <tr key={l.id}><td className="td">{i + 1}</td><td className="td">{l.description}</td><td className="td">{l.hsn}</td>
              <td className="td text-right">{l.quantity != null ? `${qty(l.quantity)} ${l.unit}` : '—'}</td><td className="td text-right">{money(l.rate)}</td><td className="td text-right">{money(l.taxable)}</td>
              {gst && <td className="td text-right">{money(l.tax)}<div className="text-xs text-slate-400">{Number(l.gstRate)}%</div></td>}<td className="td text-right">{money(l.total)}</td></tr>
          ))}</tbody>
        </table>
        <div className="ml-auto mt-4 w-72 space-y-1 text-sm">
          <R k="Taxable value" v={n.taxable} />
          {Number(n.cgst) > 0 && <R k="CGST" v={n.cgst} />}{Number(n.sgst) > 0 && <R k="SGST" v={n.sgst} />}{Number(n.igst) > 0 && <R k="IGST" v={n.igst} />}
          {Number(n.roundOff) !== 0 && <R k="Round off" v={n.roundOff} />}
          <div className="flex justify-between border-t border-slate-300 pt-1 text-base font-semibold"><span>{credit ? 'Total credit' : 'Total debit'}</span><span>{money(n.total)}</span></div>
          {credit && <><R k="Adjusted against invoice" v={n.applied} /><R k="Credit on account" v={Number(n.total) - Number(n.applied)} /></>}
        </div>
        {n.status === 'CANCELLED' && <div className="mt-4 rounded bg-red-50 p-3 text-sm text-red-700">Cancelled: {n.cancelReason}</div>}
        <div className="mt-12 flex justify-between text-sm text-slate-500"><span>Receiver's signature</span><span>For {n.tenant.name}<br /><br />Authorised signatory</span></div>
        <DocFooter />
      </div>

      <Modal title="Generate IRN" open={dlg === 'irn'} onClose={close}>
        <p className="text-sm text-slate-600">Registers <b>{n.number}</b> ({money(n.total)}) with the IRP as a {credit ? 'credit note (CRN)' : 'debit note (DBN)'} referring to {n.invoice.number}. It can be cancelled only within 24 hours.</p>
        <Preview id={n.id} base="notes" />
        <div className="mt-4 flex justify-end gap-2"><button className="btn-ghost" onClick={close}>Back</button><button className="btn-primary" disabled={act.isPending} onClick={() => act.mutate({ path: `/notes/${n.id}/einvoice` })}>Generate IRN</button></div>
        <ErrorText error={act.error} />
      </Modal>
      <ReasonDialog title="Cancel IRN" open={dlg === 'irnCancel'} onClose={close} reasons={IRN_REASONS} busy={act.isPending} error={act.error}
        note="After the IRN is cancelled you can cancel this note. The same note number cannot be registered again."
        confirm="Cancel IRN" onSubmit={(reasonCode, remark) => act.mutate({ path: `/notes/${n.id}/einvoice/cancel`, body: { reasonCode, remark } })} />
      <Modal title={`Cancel ${n.number}`} open={dlg === 'cancel'} onClose={close}>
        <p className="mb-3 text-sm text-slate-600">The ledger postings are reversed and the invoice balance is restored. The number stays used.</p>
        <input className="input" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className="mt-4 flex justify-end"><button className="btn-danger" disabled={reason.trim().length < 5 || act.isPending} onClick={() => act.mutate({ path: `/notes/${n.id}/cancel`, body: { reason: reason.trim() } })}>Cancel note</button></div>
        <ErrorText error={act.error} />
      </Modal>
    </>
  );
}
const R = ({ k, v }: { k: string; v: any }) => <div className="flex justify-between"><span className="text-slate-500">{k}</span><span className="tabular-nums">{money(v)}</span></div>;
