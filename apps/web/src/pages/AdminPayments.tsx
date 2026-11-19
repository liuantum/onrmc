import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, date, money } from '../lib/api';
import { Badge, ErrorText, Field, Modal, PageHeader, Table, Toggle, formData, useSave } from '../components/ui';
import { UpiQr } from '../components/UpiQr';
import { fileToDataUrl } from './Subscription';

export default function AdminPayments() {
  const [tab, setTab] = useState<'PENDING_VERIFICATION' | ''>('PENDING_VERIFICATION');
  const [view, setView] = useState<any>(null);
  const [reject, setReject] = useState<any>(null);
  const { data } = useQuery({ queryKey: ['admin-sub-payments', tab], queryFn: () => api(`/admin/subscription-payments${tab ? `?status=${tab}` : ''}`) });
  const keys = ['admin-sub-payments', 'admin-stats', 'tenants'];
  const approve = useSave((v) => `/admin/subscription-payments/${v.id}/approve`, keys, () => setView(null));
  const rej = useSave((v) => `/admin/subscription-payments/${v.id}/reject`, keys, () => setReject(null));
  return (
    <>
      <PageHeader title="Subscription payments" subtitle="Verify manual UPI / bank payments; gateway payments activate on their own" />
      <div className="mb-4 inline-flex rounded-lg bg-slate-100 p-1 text-sm">
        {([['PENDING_VERIFICATION', 'To verify'], ['', 'All payments']] as const).map(([k, l]) => <button key={k} onClick={() => setTab(k)} className={`rounded-md px-3 py-1.5 font-medium ${tab === k ? 'bg-white shadow-sm' : 'text-slate-500'}`}>{l}</button>)}
      </div>
      <Table rows={data} empty={tab ? 'Nothing waiting for verification' : 'No payments yet'} cols={[
        { key: 'createdAt', label: 'Submitted', render: (r: any) => date(r.createdAt) },
        { key: 'tenant', label: 'Plant owner', render: (r: any) => <><div className="font-medium">{r.tenant.name}</div><div className="text-xs text-slate-500">{r.tenant.gstin}</div></> },
        { key: 'plan', label: 'Plan', render: (r: any) => `${r.plan.name} · ${r.billingCycle.toLowerCase()}` },
        { key: 'method', label: 'Method / ref', render: (r: any) => <>{r.method.toLowerCase()}<div className="font-mono text-xs text-slate-500">{r.reference ?? r.gatewayPaymentId ?? r.gatewayOrderId}</div></> },
        { key: 'paidOn', label: 'Paid on', render: (r: any) => (r.paidOn ? date(r.paidOn) : '—') },
        { key: 'total', label: 'Amount', align: 'right', render: (r: any) => money(r.total) },
        { key: 'status', label: 'Status', render: (r: any) => <><Badge s={r.status === 'PENDING_VERIFICATION' ? 'PENDING' : r.status === 'REJECTED' ? 'FAILED' : r.status} />{r.rejectReason && <div className="text-xs text-red-600">{r.rejectReason}</div>}</> },
        { key: 'a', label: '', render: (r: any) => r.status === 'PENDING_VERIFICATION' ? <button className="btn-primary" onClick={() => setView(r)}>Review</button> : r.invoice ? <Link className="text-brand-600 hover:underline" to={`/subscription/invoices/${r.invoice.id}`}>{r.invoice.number}</Link> : null },
      ]} />
      <Modal title={`Verify payment · ${view?.tenant.name ?? ''}`} open={!!view} onClose={() => setView(null)} wide>
        {view && <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-2 text-sm">
            <p>Check your bank statement for a credit of <b>{money(view.total)}</b> with UTR <b className="font-mono">{view.reference}</b> on or around {date(view.paidOn)}.</p>
            <p className="text-slate-500">Approving activates {view.plan.name} ({view.billingCycle.toLowerCase()}) and issues the GST invoice.</p>
            <div className="flex gap-2 pt-2">
              <button className="btn-primary" disabled={approve.isPending} onClick={() => approve.mutate({ id: view.id })}>Approve and activate</button>
              <button className="btn-danger" onClick={() => { setReject(view); setView(null); }}>Reject</button>
            </div>
            <ErrorText error={approve.error} />
          </div>
          <div>{view.screenshot ? <a href={view.screenshot} target="_blank" rel="noreferrer"><img src={view.screenshot} alt="Payment screenshot" className="max-h-96 rounded-lg border border-slate-200" /></a> : <div className="rounded-lg bg-slate-50 p-6 text-center text-sm text-slate-400">No screenshot attached</div>}</div>
        </div>}
      </Modal>
      <Modal title="Reject payment" open={!!reject} onClose={() => setReject(null)}>
        <form onSubmit={(e) => rej.mutate({ id: reject.id, ...formData(e) })} className="space-y-4">
          <Field label="Reason (shown to the owner)"><input name="reason" className="input" required minLength={3} placeholder="No credit found for this UTR" /></Field>
          <div className="flex justify-end"><button className="btn-danger" disabled={rej.isPending}>Reject</button></div>
          <ErrorText error={rej.error} />
        </form>
      </Modal>
    </>
  );
}

export function AdminPaymentSettings() {
  const qc = useQueryClient();
  const { data: s } = useQuery({ queryKey: ['platform-settings'], queryFn: () => api('/admin/platform-settings') });
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null | undefined>(undefined);
  if (!s) return <div className="text-slate-400">Loading…</div>;

  async function save(e: React.FormEvent<HTMLFormElement>) {
    const d = formData(e);
    const secrets = { razorpaySecret: d.razorpaySecret, razorpayWebhook: d.razorpayWebhook, cashfreeSecret: d.cashfreeSecret, cashfreeWebhook: d.cashfreeWebhook };
    for (const k of Object.keys(secrets)) delete d[k];
    delete d.qrFile;
    setErr(null); setOk(null);
    try {
      await api('/admin/platform-settings', { method: 'PUT', body: { ...d, upiQr: qr === undefined ? undefined : qr, secrets,
        manualEnabled: !!d.manualEnabled, razorpayEnabled: !!d.razorpayEnabled, cashfreeEnabled: !!d.cashfreeEnabled } });
      setOk('Saved'); setQr(undefined); qc.invalidateQueries({ queryKey: ['platform-settings'] });
      (e.target as HTMLFormElement).querySelectorAll<HTMLInputElement>('input[type=password]').forEach((i) => (i.value = ''));
    } catch (x) { setErr((x as Error).message); }
  }
  async function test(p: string) {
    setErr(null); setOk(null);
    try { const r = await api(`/admin/platform-settings/test/${p}`, { method: 'POST' }); r.ok ? setOk(r.message) : setErr(r.message); } catch (x) { setErr((x as Error).message); }
  }
  const saved = (b: boolean) => (b ? 'saved · leave blank to keep' : 'not set');
  const qrShown = qr === undefined ? s.upiQr : qr;
  const hook = (p: string) => `${location.origin.replace(':5173', ':4000')}/api/webhooks/${p}`;
  return (
    <>
      <PageHeader title="Payment settings" subtitle="How plant owners pay for onrmc. Switch each method on or off." />
      {!s.encryptionReady && <p className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">EINVOICE_ENC_KEY is not set on the server, so gateway secrets can't be stored.</p>}
      <form onSubmit={save} className="space-y-6">
        <section className="card p-5">
          <div className="mb-4"><Toggle name="manualEnabled" defaultChecked={s.manualEnabled} label="Manual payment: UPI / QR / bank transfer" hint="Owners pay you directly and enter the UTR. You approve it under Payments. No gateway account needed." /></div>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="row-span-3">
              <span className="label">QR shown to owners</span>
              {s.upiId ? <UpiQr upiId={s.upiId} payee={s.bankAccountName || s.sellerLegalName} size={160} />
                : qrShown ? <img src={qrShown} alt="UPI QR" className="mb-2 w-40 rounded-lg border border-slate-200" /> : <div className="mb-2 flex h-40 w-40 items-center justify-center rounded-lg bg-slate-50 p-3 text-center text-xs text-slate-400">Add a UPI ID and save, or upload your QR</div>}
              <p className="mt-2 text-xs text-slate-500">{s.upiId ? 'Made from your UPI ID with the exact amount for each payment.' : 'Upload a QR image only if you have no UPI ID.'}</p>
              {!s.upiId && <input name="qrFile" type="file" accept="image/*" className="text-xs" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { if (f.size > 1_000_000) return setErr('QR image must be under 1 MB'); setQr(await fileToDataUrl(f)); } }} />}
              {!s.upiId && qrShown && <button type="button" className="btn-ghost mt-1 text-xs" onClick={() => setQr(null)}>Remove QR</button>}
            </div>
            <Field label="UPI ID"><input name="upiId" className="input" defaultValue={s.upiId ?? ''} placeholder="yourname@okhdfcbank" /></Field>
            <Field label="Account name"><input name="bankAccountName" className="input" defaultValue={s.bankAccountName ?? ''} /></Field>
            <Field label="Account number"><input name="bankAccountNo" className="input" defaultValue={s.bankAccountNo ?? ''} /></Field>
            <Field label="IFSC"><input name="bankIfsc" className="input uppercase" defaultValue={s.bankIfsc ?? ''} /></Field>
            <Field label="Bank"><input name="bankName" className="input" defaultValue={s.bankName ?? ''} /></Field>
            <Field label="Branch"><input name="bankBranch" className="input" defaultValue={s.bankBranch ?? ''} /></Field>
            <Field label="Note to owners" className="md:col-span-2"><input name="instructions" className="input" defaultValue={s.instructions ?? ''} placeholder="Mention your company name in the remarks" /></Field>
          </div>
        </section>
        <h2 className="pt-2 text-lg font-semibold">Live payment gateways</h2>
        <p className="-mt-4 text-sm text-slate-500">Off until you have a Razorpay or Cashfree account. Add the keys, test, then switch on. Owners only see the methods that are on.</p>
        <section className="card p-5">
          <div className="mb-1 flex items-center gap-2"><Toggle name="razorpayEnabled" defaultChecked={s.razorpayEnabled} label="Razorpay" />
            {s.razorpayKeyId && <span className={`badge ${s.razorpayMode === 'live' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-100 text-amber-800'}`}>{s.razorpayMode} mode</span>}</div>
          <p className="mb-4 text-xs text-slate-500">Use rzp_test_ keys until you're ready; rzp_live_ keys take real money. Webhook URL: <span className="font-mono">{hook('razorpay')}</span> (events: payment.captured, payment.failed)</p>
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Key ID"><input name="razorpayKeyId" className="input font-mono" defaultValue={s.razorpayKeyId ?? ''} placeholder="rzp_test_..." /></Field>
            <Field label={`Key secret (${saved(s.razorpaySecretSaved)})`}><input name="razorpaySecret" type="password" className="input" autoComplete="off" /></Field>
            <Field label={`Webhook secret (${saved(s.razorpayWebhookSaved)})`}><input name="razorpayWebhook" type="password" className="input" autoComplete="off" /></Field>
          </div>
          <button type="button" className="btn-ghost mt-3" onClick={() => test('razorpay')}>Test connection</button>
        </section>
        <section className="card p-5">
          <div className="mb-1 flex items-center gap-2"><Toggle name="cashfreeEnabled" defaultChecked={s.cashfreeEnabled} label="Cashfree" />
            {s.cashfreeAppId && <span className={`badge ${s.cashfreeMode === 'live' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-100 text-amber-800'}`}>{s.cashfreeMode} mode</span>}</div>
          <p className="mb-4 text-xs text-slate-500">Sandbox until you switch to production with live keys. Webhook URL: <span className="font-mono">{hook('cashfree')}</span></p>
          <div className="grid gap-4 md:grid-cols-4">
            <Field label="Environment"><select name="cashfreeEnv" className="input" defaultValue={s.cashfreeEnv}><option value="sandbox">Sandbox (test)</option><option value="production">Production</option></select></Field>
            <Field label="App ID"><input name="cashfreeAppId" className="input font-mono" defaultValue={s.cashfreeAppId ?? ''} /></Field>
            <Field label={`Secret key (${saved(s.cashfreeSecretSaved)})`}><input name="cashfreeSecret" type="password" className="input" autoComplete="off" /></Field>
            <Field label={`Webhook secret (${saved(s.cashfreeWebhookSaved)})`}><input name="cashfreeWebhook" type="password" className="input" autoComplete="off" placeholder="defaults to secret key" /></Field>
          </div>
          <button type="button" className="btn-ghost mt-3" onClick={() => test('cashfree')}>Test connection</button>
        </section>
        <section className="card p-5">
          <h2 className="mb-4 text-base font-semibold">Your GST invoice details and renewal rules</h2>
          <div className="grid gap-4 md:grid-cols-4">
            <Field label="Legal name" className="md:col-span-2"><input name="sellerLegalName" className="input" defaultValue={s.sellerLegalName} required /></Field>
            <Field label="GSTIN"><input name="sellerGstin" className="input uppercase" defaultValue={s.sellerGstin ?? ''} /></Field>
            <Field label="State code"><input name="sellerStateCode" className="input" maxLength={2} defaultValue={s.sellerStateCode} required /></Field>
            <Field label="Address" className="md:col-span-2"><input name="sellerAddress" className="input" defaultValue={s.sellerAddress ?? ''} /></Field>
            <Field label="PIN"><input name="sellerPincode" className="input" defaultValue={s.sellerPincode ?? ''} /></Field>
            <Field label="SAC"><input name="sacCode" className="input" defaultValue={s.sacCode} /></Field>
            <Field label="GST %"><input name="gstRate" type="number" step="0.01" className="input" defaultValue={Number(s.gstRate)} /></Field>
            <Field label="Grace days after expiry"><input name="graceDays" type="number" className="input" defaultValue={s.graceDays} /></Field>
            <Field label="Remind days before expiry"><input name="reminderDays" type="number" className="input" defaultValue={s.reminderDays} /></Field>
          </div>
          <p className="mt-3 text-xs text-slate-500">After the grace days, the plant owner's account becomes read-only until they renew.</p>
        </section>
        <div className="sticky bottom-0 flex items-center justify-end gap-3 bg-slate-50/80 py-3 backdrop-blur">
          {ok && <span className="text-sm text-emerald-700">{ok}</span>}
          {err && <span className="text-sm text-red-700">{err}</span>}
          <button className="btn-primary">Save settings</button>
        </div>
      </form>
    </>
  );
}
