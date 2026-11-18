import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, ExternalLink, Upload } from 'lucide-react';
import { api } from '../lib/api';
import { ErrorText, Field, Modal } from './ui';

export const IRP_PORTAL = 'https://einvoice1.gst.gov.in';
export const EWB_PORTAL = 'https://ewaybillgst.gov.in';

export function useEinvoiceProvider() {
  const { data } = useQuery({ queryKey: ['einvoice-settings'], queryFn: () => api('/einvoice/settings'), retry: false, staleTime: 60_000 });
  return data?.provider as string | undefined;
}

export function downloadJson(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Upload the portal's answer file; returns the import summary. */
export function ImportResult({ invoiceId, onDone }: { invoiceId?: string; onDone?: (r: any) => void }) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function pick(f?: File) {
    if (!f) return;
    setErr(null); setMsg(null); setBusy(true);
    try {
      const r = await api('/einvoice/portal-import', { body: { result: await f.text(), invoiceId } });
      setMsg([r.imported.length && `IRN saved for ${r.imported.map((x: any) => x.number).join(', ')}`, ...r.skipped.map((s: any) => `${s.docNo ?? '?'}: ${s.reason}`)].filter(Boolean).join(' · '));
      qc.invalidateQueries({ queryKey: ['invoices'] }); qc.invalidateQueries({ queryKey: ['notes'] });
      onDone?.(r);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div>
      <label className={`btn-ghost cursor-pointer border border-slate-200 ${busy ? 'opacity-50' : ''}`}><Upload size={16} />{busy ? 'Importing…' : 'Import portal result (JSON)'}
        <input type="file" accept=".json,application/json" className="hidden" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} /></label>
      {msg && <p className="mt-2 text-sm text-emerald-700">{msg}</p>}
      <ErrorText error={err} />
    </div>
  );
}

/** IRN without a GSP: download → upload on the IRP → import (or type the IRN in). */
export function PortalIrnDialog({ inv, onClose }: { inv: any; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: pv } = useQuery({ queryKey: ['invoices', inv.id, 'irp-preview'], queryFn: () => api(`/invoices/${inv.id}/einvoice/preview`) });
  const [hand, setHand] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function record(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api(`/invoices/${inv.id}/einvoice/record`, { body: { irn: f.get('irn'), ackNo: f.get('ackNo'), ackDate: f.get('ackDate'), signedQr: (f.get('signedQr') as string) || undefined } });
      qc.invalidateQueries({ queryKey: ['invoices'] }); onClose();
    } catch (x) { setErr((x as Error).message); }
  }
  return (
    <Modal title={`E-invoice ${inv.number} on the GST portal`} open onClose={onClose} wide>
      {pv && !pv.ok && <div className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800"><b>Fix these first:</b><ul className="ml-4 mt-1 list-disc">{pv.problems.map((p: string) => <li key={p}>{p}</li>)}</ul></div>}
      <ol className="ml-5 list-decimal space-y-3 text-sm text-slate-700">
        <li>Download this invoice in the government format.
          <div className="mt-1"><button className="btn-primary" disabled={!pv?.ok} onClick={() => downloadJson(`${inv.number.replace(/[^\w-]/g, '_')}-einvoice.json`, [pv.payload])}><Download size={16} />Download JSON</button></div></li>
        <li>Log in at <a className="text-brand-600 hover:underline" href={IRP_PORTAL} target="_blank" rel="noreferrer">einvoice1.gst.gov.in <ExternalLink size={12} className="inline" /></a> with your GST username, go to <b>e-Invoice → Bulk Upload</b>, upload the file, and download the result JSON.</li>
        <li>Bring the result back here. onrmc saves the IRN, Ack no. and signed QR, and prints them on the invoice.
          <div className="mt-1"><ImportResult invoiceId={inv.id} onDone={(r) => r.imported.length && onClose()} /></div></li>
      </ol>
      <button className="mt-4 text-xs text-brand-600" onClick={() => setHand(!hand)}>{hand ? 'Hide' : 'Only have the portal screen? Type the IRN in instead'}</button>
      {hand && <form className="mt-3 grid grid-cols-2 gap-3" onSubmit={record}>
        <Field label="IRN (64 characters)" className="col-span-2"><input name="irn" className="input font-mono text-xs" required minLength={64} maxLength={64} /></Field>
        <Field label="Ack no."><input name="ackNo" className="input font-mono" required /></Field>
        <Field label="Ack date"><input name="ackDate" type="datetime-local" className="input" required /></Field>
        <Field label="Signed QR code text (optional, needed to print the QR)" className="col-span-2"><textarea name="signedQr" className="input font-mono text-xs" rows={2} /></Field>
        <div className="col-span-2 flex justify-end"><button className="btn-primary">Save IRN</button></div>
        <div className="col-span-2"><ErrorText error={err} /></div>
      </form>}
    </Modal>
  );
}

/** E-way bill generated on the EWB portal: record its number. */
export function RecordEwbDialog({ inv, onClose }: { inv: any; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: d } = useQuery({ queryKey: ['invoices', inv.id, 'ewb-defaults', ''], queryFn: () => api(`/invoices/${inv.id}/ewaybill/defaults`) });
  const [err, setErr] = useState<string | null>(null);
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    try {
      await api(`/invoices/${inv.id}/ewaybill/record`, { body: { ewbNo: f.ewbNo.replace(/\s/g, ''), ewbDate: f.ewbDate || undefined, validUpto: f.validUpto || null, vehicleNo: f.vehicleNo, distanceKm: Number(f.distanceKm || 0), challanId: f.challanId || undefined } });
      qc.invalidateQueries({ queryKey: ['invoices'] }); onClose();
    } catch (x) { setErr((x as Error).message); }
  }
  return (
    <Modal title={`Record e-way bill for ${inv.number}`} open onClose={onClose}>
      <p className="mb-3 text-sm text-slate-600">Generate it on <a className="text-brand-600 hover:underline" href={inv.irn ? IRP_PORTAL : EWB_PORTAL} target="_blank" rel="noreferrer">{inv.irn ? 'the e-invoice portal (EWB by IRN)' : 'ewaybillgst.gov.in'}</a>{inv.irn && <> using IRN <span className="break-all font-mono text-xs">{inv.irn}</span></>}, then enter the number here.</p>
      {d && <form className="grid grid-cols-2 gap-3" onSubmit={save}>
        <Field label="E-way bill no. (12 digits)"><input name="ewbNo" className="input font-mono" required inputMode="numeric" /></Field>
        <Field label="Vehicle no."><input name="vehicleNo" className="input uppercase" defaultValue={d.vehicleNo} required /></Field>
        {d.challans.length > 1 && <Field label="Challan" className="col-span-2"><select name="challanId" className="input" defaultValue={d.challanId ?? ''}>{d.challans.map((c: any) => <option key={c.id} value={c.id}>{c.number} · {c.vehicleNo}</option>)}</select></Field>}
        <Field label="Generated on"><input name="ewbDate" type="datetime-local" className="input" /></Field>
        <Field label="Valid upto"><input name="validUpto" type="datetime-local" className="input" /></Field>
        <Field label="Distance (km)"><input name="distanceKm" type="number" className="input" defaultValue={d.distanceKm} /></Field>
        <div className="col-span-2 flex justify-end"><button className="btn-primary">Save</button></div>
        <div className="col-span-2"><ErrorText error={err} /></div>
      </form>}
    </Modal>
  );
}
