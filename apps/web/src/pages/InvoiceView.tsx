import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { Printer } from 'lucide-react';
import { api, date, dateTime, money, qty } from '../lib/api';
import { DocFooter, DocLogo } from '../components/PrintBits';
import { Badge, ErrorText, Modal, PageHeader, useSave } from '../components/ui';
import { ImportResult, PortalIrnDialog, RecordEwbDialog, useEinvoiceProvider } from '../components/PortalEinvoice';
import { NoteForm } from './Notes';

function words(n: number): string {
  const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (x: number) => (x < 20 ? a[x] : `${b[Math.floor(x / 10)]} ${a[x % 10]}`.trim());
  const three = (x: number) => (x >= 100 ? `${a[Math.floor(x / 100)]} Hundred ${two(x % 100)}` : two(x)).trim();
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const cr = Math.floor(n / 1e7), lk = Math.floor((n % 1e7) / 1e5), th = Math.floor((n % 1e5) / 1e3), rest = n % 1e3;
  if (cr) parts.push(`${three(cr)} Crore`); if (lk) parts.push(`${two(lk)} Lakh`); if (th) parts.push(`${two(th)} Thousand`); if (rest) parts.push(three(rest));
  return parts.join(' ');
}

export default function InvoiceView() {
  const { id } = useParams();
  const { data: inv } = useQuery({ queryKey: ['invoices', id], queryFn: () => api(`/invoices/${id}`) });
  const [cancel, setCancel] = useState(false);
  const [noteType, setNoteType] = useState<null | 'CREDIT' | 'DEBIT'>(null);
  const [reason, setReason] = useState('');
  const save = useSave(`/invoices/${id}/cancel`, ['invoices', 'challans'], () => setCancel(false));
  if (!inv) return <div className="text-slate-400">Loading…</div>;
  const gst = inv.type === 'TAX_INVOICE';
  return (
    <>
      <PageHeader title={inv.number} subtitle={gst ? 'Tax invoice' : 'Bill of supply'} actions={<>
        <Badge s={inv.status} />
        <button className="btn-ghost" onClick={() => print()}><Printer size={16} />Print / PDF</button>
        {inv.status !== 'CANCELLED' && <button className="btn-ghost" onClick={() => setNoteType('CREDIT')}>Credit note</button>}
        {inv.status !== 'CANCELLED' && <button className="btn-ghost" onClick={() => setNoteType('DEBIT')}>Debit note</button>}
        {inv.status !== 'CANCELLED' && Number(inv.paid) === 0 && inv.einvoiceStatus !== 'GENERATED' && <button className="btn-danger" onClick={() => setCancel(true)}>Cancel invoice</button>}
      </>} />
      <EinvoicePanel inv={inv} />
      <div className="card mx-auto max-w-4xl p-8 print:border-0 print:shadow-none">
        <div className="flex justify-between border-b border-slate-200 pb-4">
          <div className="flex items-start gap-4">
            <DocLogo src={inv.tenant.logoUrl} />
            <div>
            <div className="text-xl font-bold">{inv.tenant.legalName ?? inv.tenant.name}</div>
            <div className="text-sm text-slate-600">{inv.tenant.address}</div>
            {inv.tenant.gstin && <div className="text-sm">GSTIN: <b>{inv.tenant.gstin}</b></div>}
            </div>
          </div>
          <div className="flex gap-4 text-right">
            <div>
              <div className="text-lg font-semibold uppercase tracking-wide">{gst ? 'Tax Invoice' : 'Bill of Supply'}</div>
              <div className="text-sm">No: <b>{inv.number}</b></div>
              <div className="text-sm">Date: {date(inv.issueDate)}</div>
              <div className="text-sm">Due: {date(inv.dueDate)}</div>
            </div>
            {inv.einvoiceStatus === 'GENERATED' && inv.signedQr && <QrImage text={inv.signedQr} />}
          </div>
        </div>
        {inv.irn && (
          <div className="border-b border-slate-200 py-2 text-xs leading-5">
            <div><span className="text-slate-500">IRN:</span> <span className="break-all font-mono">{inv.irn}</span>{inv.einvoiceStatus === 'CANCELLED' && <b className="ml-2 text-red-600">IRN CANCELLED</b>}</div>
            <div><span className="text-slate-500">Ack No:</span> {inv.ackNo} · <span className="text-slate-500">Ack Date:</span> {inv.ackDate && dateTime(inv.ackDate)}</div>
            {activeEwb(inv) && <div><span className="text-slate-500">E-way bill:</span> <b>{activeEwb(inv).ewbNo}</b> · {activeEwb(inv).vehicleNo} · valid upto {activeEwb(inv).validUpto ? dateTime(activeEwb(inv).validUpto) : 'Part-B pending'}</div>}
          </div>
        )}
        <div className="grid grid-cols-2 gap-4 border-b border-slate-200 py-4 text-sm">
          <div><div className="label">Bill to</div><div className="font-semibold">{inv.customer.name}</div><div>{inv.customer.billingAddress}</div>{inv.customer.gstin && <div>GSTIN: {inv.customer.gstin}</div>}</div>
          <div className="text-right"><div className="label">Place of supply</div><div>State code {inv.placeOfSupply}</div></div>
        </div>
        <table className="mt-4 w-full text-sm">
          <thead className="bg-slate-50"><tr><th className="th">#</th><th className="th">Description</th><th className="th">HSN/SAC</th><th className="th text-right">Qty</th><th className="th text-right">Rate</th><th className="th text-right">Taxable</th>{gst && <th className="th text-right">GST</th>}<th className="th text-right">Amount</th></tr></thead>
          <tbody>{inv.lines.map((l: any, i: number) => (
            <tr key={l.id}><td className="td">{i + 1}</td><td className="td">{l.description}{l.challan && <div className="text-xs text-slate-500">Truck {l.challan.vehicle.number} · {date(l.challan.deliveredAt)}</div>}</td><td className="td">{l.hsn}</td>
              <td className="td text-right">{qty(l.quantity)} {l.unit}</td><td className="td text-right">{money(l.rate)}</td><td className="td text-right">{money(l.taxable)}</td>{gst && <td className="td text-right">{money(l.tax)}<div className="text-xs text-slate-400">{Number(l.gstRate)}%</div></td>}<td className="td text-right">{money(l.total)}</td></tr>
          ))}</tbody>
        </table>
        <div className="ml-auto mt-4 w-72 space-y-1 text-sm">
          <Row k="Taxable value" v={inv.taxable} />
          {Number(inv.cgst) > 0 && <Row k="CGST" v={inv.cgst} />}
          {Number(inv.sgst) > 0 && <Row k="SGST" v={inv.sgst} />}
          {Number(inv.igst) > 0 && <Row k="IGST" v={inv.igst} />}
          {Number(inv.roundOff) !== 0 && <Row k="Round off" v={inv.roundOff} />}
          <div className="flex justify-between border-t border-slate-300 pt-1 text-base font-semibold"><span>Total</span><span>{money(inv.total)}</span></div>
          {Number(inv.noteAdj) !== 0 && <Row k="Credit / debit notes" v={inv.noteAdj} />}
          <Row k="Paid" v={inv.paid} /><Row k="Balance" v={Number(inv.total) + Number(inv.noteAdj) - Number(inv.paid)} />
        </div>
        <div className="mt-4 text-sm"><span className="text-slate-500">Amount in words:</span> Rupees {words(Math.round(Number(inv.total)))} Only</div>
        {inv.status === 'CANCELLED' && <div className="mt-4 rounded bg-red-50 p-3 text-sm text-red-700">Cancelled: {inv.cancelReason}</div>}
        {inv.creditDebitNotes?.length > 0 && (
          <div className="no-print mt-4 rounded-lg bg-slate-50 p-3 text-sm">
            <div className="label">Credit / debit notes</div>
            {inv.creditDebitNotes.map((n: any) => (
              <div key={n.id} className="flex items-center justify-between py-0.5">
                <Link to={`/notes/${n.id}`} className="text-brand-600">{n.number}</Link>
                <span className="text-slate-500">{n.type === 'CREDIT' ? 'Credit' : 'Debit'} · {n.reason.replace(/_/g, ' ').toLowerCase()} · {date(n.issueDate)}</span>
                <span className="flex items-center gap-2 tabular-nums">{n.type === 'CREDIT' ? '−' : '+'}{money(n.total)} <Badge s={n.status} /></span>
              </div>
            ))}
          </div>
        )}
        <div className="mt-12 flex justify-between text-sm text-slate-500"><span>Receiver's signature</span><span>For {inv.tenant.name}<br /><br />Authorised signatory</span></div>
        <DocFooter />
      </div>
      {noteType && <NoteForm invoice={inv} type={noteType} onClose={() => setNoteType(null)} />}
      <Modal title="Cancel invoice" open={cancel} onClose={() => setCancel(false)}>
        <p className="mb-3 text-sm text-slate-600">The ledger postings will be reversed and the challans become billable again. The number stays used, as GST rules require.</p>
        <input className="input" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className="mt-4 flex justify-end"><button className="btn-danger" disabled={reason.length < 5 || save.isPending} onClick={() => save.mutate({ reason })}>Cancel invoice</button></div>
        <ErrorText error={save.error} />
      </Modal>
    </>
  );
}
const Row = ({ k, v }: { k: string; v: any }) => <div className="flex justify-between"><span className="text-slate-500">{k}</span><span className="tabular-nums">{money(v)}</span></div>;

const activeEwb = (inv: any) => inv.ewayBills?.find((e: any) => e.status === 'ACTIVE');

export function QrImage({ text }: { text: string }) {
  const [src, setSrc] = useState<string>('');
  useEffect(() => { QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 1, width: 360 }).then(setSrc).catch(() => setSrc('')); }, [text]);
  return src ? <img src={src} alt="e-invoice signed QR code" className="h-32 w-32" /> : <div className="h-32 w-32 bg-slate-50" />;
}

/** Calls an endpoint, refreshes the invoice, surfaces the server's error message. */
export function useAction(method: 'POST' | 'PATCH', onDone?: () => void) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => api(path, { method, body: body ?? {} }),
    onSuccess: () => { setError(null); qc.invalidateQueries({ queryKey: ['invoices'] }); qc.invalidateQueries({ queryKey: ['notes'] }); onDone?.(); },
    onError: (e: Error) => { setError(e.message); qc.invalidateQueries({ queryKey: ['invoices'] }); qc.invalidateQueries({ queryKey: ['notes'] }); },
  });
  return { ...m, error, reset: () => { setError(null); m.reset(); } };
}

export const IRN_REASONS = [['1', 'Duplicate'], ['2', 'Data entry mistake'], ['3', 'Order cancelled'], ['4', 'Others']];
const EWB_CANCEL_REASONS = [['1', 'Duplicate'], ['2', 'Order cancelled'], ['3', 'Data entry mistake'], ['4', 'Others']];
const VEHICLE_REASONS = [['1', 'Due to break down'], ['2', 'Due to transhipment'], ['3', 'Others'], ['4', 'First time']];

type Dialog = null | 'irn' | 'irnCancel' | 'ewb' | 'vehicle' | 'ewbCancel' | 'portalIrn' | 'recordEwb';

function EinvoicePanel({ inv }: { inv: any }) {
  const [dlg, setDlg] = useState<Dialog>(null);
  const close = () => { setDlg(null); post.reset(); patch.reset(); };
  const post = useAction('POST', () => setDlg(null));
  const patch = useAction('PATCH', () => setDlg(null));
  const ewb = activeEwb(inv);
  const portal = useEinvoiceProvider() === 'PORTAL';
  if (inv.type !== 'TAX_INVOICE' || inv.einvoiceStatus === 'NOT_REQUIRED') {
    return inv.type === 'TAX_INVOICE' ? <p className="no-print mx-auto mb-3 max-w-4xl text-xs text-slate-400">E-invoice not required for this invoice (B2C or e-invoicing switched off).</p> : null;
  }
  const irnOpen = inv.einvoiceStatus === 'PENDING' || inv.einvoiceStatus === 'FAILED';
  const within24 = inv.ackDate && Date.now() - new Date(inv.ackDate).getTime() < 24 * 3600e3;
  return (
    <div className="no-print card mx-auto mb-4 max-w-4xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">E-invoice</span><Badge s={inv.einvoiceStatus} />
          {ewb && <><span className="ml-3 font-medium">E-way bill</span><span className="font-mono">{ewb.ewbNo}</span></>}
        </div>
        <div className="flex flex-wrap gap-2">
          {irnOpen && inv.status !== 'CANCELLED' && <button className="btn-primary" onClick={() => setDlg(portal ? 'portalIrn' : 'irn')}>{portal ? 'Get IRN from GST portal' : 'Generate IRN'}</button>}
          {inv.einvoiceStatus === 'GENERATED' && !ewb && (portal ? <button className="btn-primary" onClick={() => setDlg('recordEwb')}>Record e-way bill</button> : <button className="btn-primary" onClick={() => setDlg('ewb')}>Generate e-way bill</button>)}
          {inv.einvoiceStatus === 'GENERATED' && !inv.signedQr && portal && <ImportResult />}
          {ewb && <button className="btn-ghost" onClick={() => setDlg('vehicle')}>Update vehicle</button>}
          {ewb && <button className="btn-ghost" onClick={() => setDlg('ewbCancel')}>Cancel e-way bill</button>}
          {inv.einvoiceStatus === 'GENERATED' && !ewb && within24 && <button className="btn-danger" onClick={() => setDlg('irnCancel')}>Cancel IRN</button>}
        </div>
      </div>
      {inv.einvoiceStatus === 'FAILED' && inv.einvoiceError && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{inv.einvoiceError}</p>}
      {inv.einvoiceStatus === 'GENERATED' && !within24 && <p className="mt-2 text-xs text-slate-500">IRN is older than 24 hours and can no longer be cancelled. Use a credit note for corrections.</p>}

      <Modal title="Generate IRN" open={dlg === 'irn'} onClose={close}>
        <p className="text-sm text-slate-600">This registers <b>{inv.number}</b> ({money(inv.total)}) with the Invoice Registration Portal using the amounts already on the invoice. Once generated, the IRN can be cancelled only within 24 hours, and the invoice number cannot be reused.</p>
        <Preview id={inv.id} />
        <div className="mt-4 flex justify-end gap-2"><button className="btn-ghost" onClick={close}>Back</button><button className="btn-primary" disabled={post.isPending} onClick={() => post.mutate({ path: `/invoices/${inv.id}/einvoice` })}>{post.isPending ? 'Generating…' : 'Generate IRN'}</button></div>
        <ErrorText error={post.error} />
      </Modal>

      <ReasonDialog title="Cancel IRN" open={dlg === 'irnCancel'} onClose={close} reasons={IRN_REASONS} busy={post.isPending} error={post.error}
        note={`${portal ? 'Cancel the IRN on einvoice1.gst.gov.in first; this records it in onrmc. ' : ''}After the IRN is cancelled you can cancel this invoice. The same invoice number cannot be registered again.`}
        confirm="Cancel IRN" onSubmit={(reasonCode, remark) => post.mutate({ path: `/invoices/${inv.id}/einvoice/cancel`, body: { reasonCode, remark } })} />

      {dlg === 'ewb' && <EwbDialog inv={inv} onClose={close} act={post} />}
      {dlg === 'portalIrn' && <PortalIrnDialog inv={inv} onClose={close} />}
      {dlg === 'recordEwb' && <RecordEwbDialog inv={inv} onClose={close} />}

      {dlg === 'vehicle' && ewb && <VehicleDialog ewb={ewb} onClose={close} act={patch} />}

      <ReasonDialog title={`Cancel e-way bill ${ewb?.ewbNo ?? ''}`} open={dlg === 'ewbCancel'} onClose={close} reasons={EWB_CANCEL_REASONS} busy={post.isPending} error={post.error}
        note={`${portal ? 'Cancel it on ewaybillgst.gov.in first; this records it in onrmc. ' : ''}E-way bills can be cancelled only within 24 hours of generation, and only if the goods have not been verified in transit.`}
        confirm="Cancel e-way bill" onSubmit={(reasonCode, remark) => post.mutate({ path: `/ewaybill/${ewb.id}/cancel`, body: { reasonCode, remark } })} />
    </div>
  );
}

export function Preview({ id, base = 'invoices' }: { id: string; base?: 'invoices' | 'notes' }) {
  const { data } = useQuery({ queryKey: [base, id, 'irp-preview'], queryFn: () => api(`/${base}/${id}/einvoice/preview`) });
  if (!data) return <p className="mt-3 text-xs text-slate-400">Checking invoice data…</p>;
  if (!data.ok) return <div className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800"><b>Fix these first:</b><ul className="ml-4 mt-1 list-disc">{data.problems.map((p: string) => <li key={p}>{p}</li>)}</ul></div>;
  const v = data.payload.ValDtls;
  return <p className="mt-3 rounded-lg bg-emerald-50 p-3 text-xs text-emerald-800">Checks passed · {data.payload.ItemList.length} items · taxable {money(v.AssVal)} · GST {money(v.CgstVal + v.SgstVal + v.IgstVal)} · total {money(v.TotInvVal)}</p>;
}

export function ReasonDialog({ title, open, onClose, reasons, note, confirm, onSubmit, busy, error }: {
  title: string; open: boolean; onClose: () => void; reasons: string[][]; note: string; confirm: string; busy: boolean; error: string | null; onSubmit: (code: string, remark: string) => void;
}) {
  const [code, setCode] = useState(reasons[1][0]);
  const [remark, setRemark] = useState('');
  return (
    <Modal title={title} open={open} onClose={onClose}>
      <p className="mb-3 text-sm text-slate-600">{note}</p>
      <div className="grid grid-cols-2 gap-3">
        <label className="block"><span className="label">Reason</span><select className="input" value={code} onChange={(e) => setCode(e.target.value)}>{reasons.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="block"><span className="label">Remark</span><input className="input" value={remark} maxLength={50} onChange={(e) => setRemark(e.target.value)} placeholder="Required" /></label>
      </div>
      <div className="mt-4 flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Back</button><button className="btn-danger" disabled={remark.trim().length < 3 || busy} onClick={() => onSubmit(code, remark.trim())}>{confirm}</button></div>
      <ErrorText error={error} />
    </Modal>
  );
}

function EwbDialog({ inv, onClose, act }: { inv: any; onClose: () => void; act: ReturnType<typeof useAction> }) {
  const [challanId, setChallanId] = useState('');
  const { data: d } = useQuery({ queryKey: ['invoices', inv.id, 'ewb-defaults', challanId], queryFn: () => api(`/invoices/${inv.id}/ewaybill/defaults${challanId ? `?challanId=${challanId}` : ''}`) });
  const [vehicleNo, setVehicleNo] = useState<string | null>(null);
  const [distanceKm, setDistanceKm] = useState<number | null>(null);
  const veh = vehicleNo ?? d?.vehicleNo ?? '';
  const km = distanceKm ?? d?.distanceKm ?? 0;
  return (
    <Modal title="Generate e-way bill" open onClose={onClose}>
      {!d ? <p className="text-sm text-slate-400">Loading…</p> : <>
        <p className="mb-3 text-sm text-slate-600">Created from IRN of {inv.number}. From PIN {d.fromPin ?? '—'} (plant) to PIN {d.toPin ?? '—'} (site), by road.</p>
        <div className="grid grid-cols-2 gap-3">
          {d.challans.length > 1 && <label className="col-span-2 block"><span className="label">Challan / truck</span>
            <select className="input" value={challanId || d.challanId || ''} onChange={(e) => { setChallanId(e.target.value); setVehicleNo(null); }}>{d.challans.map((c: any) => <option key={c.id} value={c.id}>{c.number} · {c.vehicleNo}</option>)}</select></label>}
          <label className="block"><span className="label">Vehicle number</span><input className="input uppercase" value={veh} onChange={(e) => setVehicleNo(e.target.value)} /></label>
          <label className="block"><span className="label">Distance (km)</span><input className="input" type="number" min={0} max={4000} value={km} onChange={(e) => setDistanceKm(Number(e.target.value))} /></label>
        </div>
        <p className="mt-2 text-xs text-slate-400">Distance is estimated from plant and site locations. Enter 0 to let the portal calculate it from PIN codes.</p>
      </>}
      <div className="mt-4 flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Back</button>
        <button className="btn-primary" disabled={!d || !veh || act.isPending} onClick={() => act.mutate({ path: `/invoices/${inv.id}/ewaybill`, body: { challanId: challanId || d?.challanId || undefined, vehicleNo: veh, distanceKm: km } })}>{act.isPending ? 'Generating…' : 'Generate e-way bill'}</button></div>
      <ErrorText error={act.error} />
    </Modal>
  );
}

function VehicleDialog({ ewb, onClose, act }: { ewb: any; onClose: () => void; act: ReturnType<typeof useAction> }) {
  const [vehicleNo, setVehicleNo] = useState('');
  const [reasonCode, setReason] = useState('1');
  const [remark, setRemark] = useState('');
  return (
    <Modal title={`Update vehicle · EWB ${ewb.ewbNo}`} open onClose={onClose}>
      <p className="mb-3 text-sm text-slate-600">Current vehicle: <b>{ewb.vehicleNo ?? '—'}</b>. Updating Part-B is required whenever the goods move to another truck.</p>
      <div className="grid grid-cols-2 gap-3">
        <label className="block"><span className="label">New vehicle number</span><input className="input uppercase" value={vehicleNo} onChange={(e) => setVehicleNo(e.target.value)} /></label>
        <label className="block"><span className="label">Reason</span><select className="input" value={reasonCode} onChange={(e) => setReason(e.target.value)}>{VEHICLE_REASONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="col-span-2 block"><span className="label">Remark</span><input className="input" value={remark} maxLength={50} onChange={(e) => setRemark(e.target.value)} /></label>
      </div>
      <div className="mt-4 flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Back</button>
        <button className="btn-primary" disabled={!vehicleNo || remark.trim().length < 3 || act.isPending} onClick={() => act.mutate({ path: `/ewaybill/${ewb.id}/vehicle`, body: { vehicleNo, reasonCode, remark: remark.trim() } })}>Update vehicle</button></div>
      <ErrorText error={act.error} />
    </Modal>
  );
}
