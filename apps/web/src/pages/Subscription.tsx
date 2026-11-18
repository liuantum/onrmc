import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Check, CreditCard, QrCode } from 'lucide-react';
import { api, date, money } from '../lib/api';
import { Badge, ErrorText, Field, Modal, PageHeader, Table, formData } from '../components/ui';
import { UpiQr } from '../components/UpiQr';

declare global { interface Window { Razorpay?: any; Cashfree?: any } }

function loadScript(src: string) {
  return new Promise<void>((ok, fail) => {
    if (document.querySelector(`script[src="${src}"]`)) return ok();
    const s = document.createElement('script');
    s.src = src; s.onload = () => ok(); s.onerror = () => fail(new Error('Could not load the payment page. Check your internet connection.'));
    document.body.appendChild(s);
  });
}
export const fileToDataUrl = (f: File) => new Promise<string>((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = fail; r.readAsDataURL(f); });

export function SubscriptionBanner() {
  const { data } = useQuery({ queryKey: ['subscription'], queryFn: () => api('/subscription/status'), refetchInterval: 300_000 });
  if (!data?.message) return null;
  const paused = data.state === 'PAUSED';
  return (
    <div className={`no-print flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm ${paused ? 'bg-red-600 text-white' : 'bg-amber-100 text-amber-900'}`}>
      <span>{data.message}</span>
      {data.plans ? <Link to="/subscription" className={`rounded-md px-3 py-1 font-medium ${paused ? 'bg-white text-red-700' : 'bg-amber-900 text-white'}`}>Renew now</Link> : paused && <span className="opacity-90">Ask the owner to renew.</span>}
    </div>
  );
}

export default function Subscription() {
  const qc = useQueryClient();
  const { data: s } = useQuery({ queryKey: ['subscription'], queryFn: () => api('/subscription/status') });
  const { data: payments } = useQuery({ queryKey: ['subscription-payments'], queryFn: () => api('/subscription/payments') });
  const [cycle, setCycle] = useState<'MONTHLY' | 'YEARLY'>('YEARLY');
  const [pick, setPick] = useState<any>(null);
  const [manual, setManual] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['subscription'] }); qc.invalidateQueries({ queryKey: ['subscription-payments'] }); };

  // back from a Cashfree redirect
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('cf');
    if (!id) return;
    history.replaceState(null, '', '/subscription');
    api('/subscription/cashfree/verify', { body: { paymentId: id } }).then(() => { setDone('Payment received. Your plan is active.'); refresh(); }).catch((e) => setErr(e.message));
  }, []);

  if (!s) return <div className="text-slate-400">Loading…</div>;
  const q = (planId: string) => s.quotes.find((x: any) => x.planId === planId && x.cycle === cycle);
  const m = s.methods ?? {};
  const none = !m.manual && !m.razorpay && !m.cashfree;

  async function payRazorpay() {
    setErr(null); setBusy(true);
    try {
      await loadScript('https://checkout.razorpay.com/v1/checkout.js');
      const o = await api('/subscription/razorpay/order', { body: { planId: pick.id, cycle } });
      const rz = new window.Razorpay({
        key: o.keyId, order_id: o.orderId, amount: o.amount, currency: o.currency, name: o.name, description: o.description, prefill: o.prefill, theme: { color: '#1d4ed8' },
        handler: async (r: any) => {
          try { await api('/subscription/razorpay/verify', { body: { paymentId: o.paymentId, ...r } }); setPick(null); setDone('Payment received. Your plan is active.'); refresh(); }
          catch (e) { setErr((e as Error).message); }
        },
        modal: { ondismiss: () => setBusy(false) },
      });
      rz.on('payment.failed', (r: any) => setErr(r.error?.description ?? 'Payment failed'));
      rz.open();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function payCashfree() {
    setErr(null); setBusy(true);
    try {
      await loadScript('https://sdk.cashfree.com/js/v3/cashfree.js');
      const o = await api('/subscription/cashfree/order', { body: { planId: pick.id, cycle, returnUrl: `${location.origin}/subscription` } });
      const cf = window.Cashfree({ mode: o.env === 'production' ? 'production' : 'sandbox' });
      const r = await cf.checkout({ paymentSessionId: o.paymentSessionId, redirectTarget: '_modal' });
      if (r?.error) throw new Error(r.error.message ?? 'Payment was not completed');
      await api('/subscription/cashfree/verify', { body: { paymentId: o.paymentId } });
      setPick(null); setDone('Payment received. Your plan is active.'); refresh();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function submitManual(e: React.FormEvent<HTMLFormElement>) {
    const f = e.currentTarget.elements.namedItem('shot') as HTMLInputElement;
    const d = formData(e);
    setErr(null); setBusy(true);
    try {
      const file = f.files?.[0];
      if (file && file.size > 2_000_000) throw new Error('Screenshot must be under 2 MB');
      await api('/subscription/manual', { body: { planId: pick.id, cycle, reference: d.reference, paidOn: d.paidOn, screenshot: file ? await fileToDataUrl(file) : undefined } });
      setManual(false); setPick(null); setDone('Thanks! We will verify your payment and activate the plan, usually within a few hours.'); refresh();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const testTag = (mode?: string) => mode === 'test' && <span className="badge ml-2 bg-amber-100 text-amber-800">test mode</span>;
  return (
    <>
      <PageHeader title="Subscription" subtitle="Your onrmc plan and payments" />
      <div className="card mb-6 flex flex-wrap items-center justify-between gap-4 p-5">
        <div>
          <div className="text-sm text-slate-500">Current plan</div>
          <div className="text-xl font-semibold">{s.plan?.name ?? 'None'} {s.state && <Badge s={s.state === 'GRACE' ? 'PAST_DUE' : s.state === 'PAUSED' ? 'SUSPENDED' : s.state} />}</div>
          {s.endsAt && <div className="text-sm text-slate-500">{s.state === 'PAUSED' || s.state === 'GRACE' ? 'Expired' : 'Valid till'} {date(s.endsAt)}{s.state === 'GRACE' && ` · read-only from ${date(s.graceUntil)}`}</div>}
        </div>
        <div className="inline-flex rounded-lg bg-slate-100 p-1 text-sm">
          {(['MONTHLY', 'YEARLY'] as const).map((c) => <button key={c} onClick={() => setCycle(c)} className={`rounded-md px-3 py-1.5 font-medium ${cycle === c ? 'bg-white shadow-sm' : 'text-slate-500'}`}>{c === 'MONTHLY' ? 'Monthly' : 'Yearly'}</button>)}
        </div>
      </div>
      {done && <p className="mb-4 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{done}</p>}
      {none && <p className="mb-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">Online renewal isn't set up yet. Please contact onrmc support.</p>}
      <div className="mb-8 grid gap-4 md:grid-cols-3">
        {s.plans.map((p: any) => {
          const x = q(p.id);
          return (
            <div key={p.id} className={`card flex flex-col p-5 ${s.plan?.id === p.id ? 'ring-2 ring-brand-500' : ''}`}>
              <div className="text-lg font-semibold">{p.name}</div>
              <div className="mt-1 text-2xl font-bold text-brand-700">{money(x?.taxable ?? 0)}<span className="text-sm font-normal text-slate-500">/{cycle === 'YEARLY' ? 'year' : 'month'} + GST</span></div>
              <div className="text-xs text-slate-500">{money(x?.total ?? 0)} incl. {x?.gstRate}% GST</div>
              <ul className="my-4 flex-1 space-y-1 text-sm text-slate-600">
                <li>{p.maxPlants} plant(s) · {p.maxUsers} users · {p.maxVehicles} trucks</li>
                {p.features.map((f: string) => <li key={f} className="flex items-center gap-1.5"><Check size={14} className="text-emerald-600" />{f.replace(/_/g, ' ')}</li>)}
              </ul>
              <button className="btn-primary justify-center" disabled={none} onClick={() => { setErr(null); setDone(null); setPick(p); }}>{s.plan?.id === p.id ? 'Renew' : 'Choose'} {p.name}</button>
            </div>
          );
        })}
      </div>
      <h2 className="mb-3 text-lg font-semibold">Payment history</h2>
      <Table rows={payments} empty="No payments yet" cols={[
        { key: 'createdAt', label: 'Date', render: (r: any) => date(r.createdAt) },
        { key: 'plan', label: 'Plan', render: (r: any) => `${r.plan.name} · ${r.billingCycle.toLowerCase()}` },
        { key: 'method', label: 'Method', render: (r: any) => <>{r.method.toLowerCase()}{r.reference && <div className="text-xs text-slate-500">UTR {r.reference}</div>}</> },
        { key: 'total', label: 'Amount', align: 'right', render: (r: any) => money(r.total) },
        { key: 'status', label: 'Status', render: (r: any) => <><Badge s={r.status === 'PENDING_VERIFICATION' ? 'PENDING' : r.status === 'REJECTED' ? 'FAILED' : r.status} />{r.rejectReason && <div className="text-xs text-red-600">{r.rejectReason}</div>}</> },
        { key: 'inv', label: 'Invoice', render: (r: any) => (r.invoice ? <Link className="text-brand-600 hover:underline" to={`/subscription/invoices/${r.invoice.id}`}>{r.invoice.number}</Link> : '—') },
      ]} />

      <Modal title={`Pay for ${pick?.name ?? ''} · ${cycle === 'YEARLY' ? '1 year' : '1 month'}`} open={!!pick && !manual} onClose={() => setPick(null)}>
        {pick && <div className="mb-4 rounded-lg bg-slate-50 p-3 text-sm">
          <div className="flex justify-between"><span>Plan price</span><span>{money(q(pick.id).taxable)}</span></div>
          {q(pick.id).igst > 0 ? <div className="flex justify-between"><span>IGST</span><span>{money(q(pick.id).igst)}</span></div>
            : <><div className="flex justify-between"><span>CGST</span><span>{money(q(pick.id).cgst)}</span></div><div className="flex justify-between"><span>SGST</span><span>{money(q(pick.id).sgst)}</span></div></>}
          <div className="mt-1 flex justify-between border-t border-slate-200 pt-1 font-semibold"><span>Total</span><span>{money(q(pick.id).total)}</span></div>
        </div>}
        <div className="space-y-2">
          {m.razorpay && <button className="btn-ghost w-full justify-start border border-slate-200" disabled={busy} onClick={payRazorpay}><CreditCard size={18} />UPI, card or netbanking (Razorpay){testTag(m.razorpay.mode)}</button>}
          {m.cashfree && <button className="btn-ghost w-full justify-start border border-slate-200" disabled={busy} onClick={payCashfree}><CreditCard size={18} />UPI, card or netbanking (Cashfree){testTag(m.cashfree.mode)}</button>}
          {m.manual && <button className="btn-ghost w-full justify-start border border-slate-200" disabled={busy} onClick={() => setManual(true)}><QrCode size={18} />Scan QR or bank transfer, then enter the UTR</button>}
        </div>
        <ErrorText error={err} />
      </Modal>

      <Modal title="Pay by UPI or bank transfer" open={manual} onClose={() => setManual(false)} wide>
        {pick && m.manual && <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-3 text-sm">
            <div className="rounded-lg bg-brand-50 p-3 text-center"><div className="text-xs text-slate-500">Amount to pay</div><div className="text-2xl font-bold text-brand-700">{money(q(pick.id).total)}</div></div>
            {m.manual.upiId
              ? <UpiQr upiId={m.manual.upiId} payee={m.manual.payeeName} amount={Number(q(pick.id).total)} note={`onrmc ${pick.name} ${cycle === 'YEARLY' ? '1y' : '1m'}`} />
              : m.manual.upiQr && <img src={m.manual.upiQr} alt="UPI QR code" className="mx-auto w-52 rounded-lg border border-slate-200" />}
            {m.manual.upiId && <div className="text-center">UPI ID: <span className="font-mono font-medium">{m.manual.upiId}</span> <button type="button" className="text-xs text-brand-600" onClick={() => navigator.clipboard?.writeText(m.manual.upiId)}>copy</button></div>}
            {m.manual.bankAccountNo && <div className="rounded-lg border border-slate-200 p-3">
              <div className="mb-1 flex items-center gap-1.5 font-medium"><Building2 size={15} />Bank transfer (NEFT / RTGS / IMPS)</div>
              <div>{m.manual.bankAccountName}</div><div>A/c <span className="font-mono">{m.manual.bankAccountNo}</span></div>
              <div>IFSC <span className="font-mono">{m.manual.bankIfsc}</span></div><div className="text-slate-500">{[m.manual.bankName, m.manual.bankBranch].filter(Boolean).join(', ')}</div>
            </div>}
            {m.manual.instructions && <p className="text-slate-500">{m.manual.instructions}</p>}
          </div>
          <form className="space-y-4" onSubmit={submitManual}>
            <p className="text-sm text-slate-600">After paying, enter the UTR / transaction reference from your bank or UPI app. Your plan activates once onrmc verifies it.</p>
            <Field label="UTR / reference no."><input name="reference" className="input font-mono" required minLength={6} maxLength={40} /></Field>
            <Field label="Paid on"><input name="paidOn" type="date" className="input" required defaultValue={new Date().toISOString().slice(0, 10)} /></Field>
            <Field label="Screenshot (optional)"><input name="shot" type="file" accept="image/*" className="input" /></Field>
            <button className="btn-primary w-full justify-center" disabled={busy}>{busy ? 'Submitting…' : 'Submit for verification'}</button>
            <ErrorText error={err} />
          </form>
        </div>}
      </Modal>
    </>
  );
}

export function SubscriptionInvoiceView({ id }: { id: string }) {
  const { data: inv } = useQuery({ queryKey: ['sub-invoice', id], queryFn: () => api(`/subscription/invoices/${id}`) });
  if (!inv) return <div className="text-slate-400">Loading…</div>;
  const s = inv.seller;
  return (
    <>
      <PageHeader title={inv.number} subtitle="Tax invoice for onrmc subscription" actions={<button className="btn-ghost" onClick={() => print()}>Print / PDF</button>} />
      <div className="card mx-auto max-w-3xl p-8 text-sm">
        <div className="flex justify-between border-b border-slate-200 pb-4">
          <div><div className="text-lg font-bold">{s.legalName}</div><div className="text-slate-500">{s.address}{s.pincode && ` - ${s.pincode}`}</div>{s.gstin && <div>GSTIN {s.gstin}</div>}</div>
          <div className="text-right"><div className="text-lg font-semibold">TAX INVOICE</div><div>{inv.number}</div><div>{date(inv.issueDate)}</div></div>
        </div>
        <div className="grid grid-cols-2 gap-4 py-4">
          <div><div className="text-xs uppercase text-slate-500">Billed to</div><div className="font-medium">{inv.buyerName}</div><div>{inv.buyerAddress}</div>{inv.buyerGstin && <div>GSTIN {inv.buyerGstin}</div>}</div>
          <div className="text-right"><div className="text-xs uppercase text-slate-500">Place of supply</div><div>State code {inv.placeOfSupply}</div></div>
        </div>
        <table className="w-full"><thead className="bg-slate-50"><tr><th className="th">Description</th><th className="th">SAC</th><th className="th text-right">Taxable</th><th className="th text-right">GST</th><th className="th text-right">Amount</th></tr></thead>
          <tbody><tr><td className="td">{inv.description}</td><td className="td">{inv.sac}</td><td className="td text-right">{money(inv.taxable)}</td><td className="td text-right">{Number(inv.gstRate)}%</td><td className="td text-right">{money(inv.total)}</td></tr></tbody></table>
        <div className="ml-auto mt-4 w-64 space-y-1">
          <div className="flex justify-between"><span>Taxable value</span><span>{money(inv.taxable)}</span></div>
          {inv.interState ? <div className="flex justify-between"><span>IGST</span><span>{money(inv.igst)}</span></div>
            : <><div className="flex justify-between"><span>CGST</span><span>{money(inv.cgst)}</span></div><div className="flex justify-between"><span>SGST</span><span>{money(inv.sgst)}</span></div></>}
          <div className="flex justify-between border-t border-slate-200 pt-1 font-semibold"><span>Total</span><span>{money(inv.total)}</span></div>
        </div>
        <div className="mt-6 text-xs text-slate-500">Paid via {inv.payment.method.toLowerCase()}{inv.payment.reference && ` · UTR ${inv.payment.reference}`}{inv.payment.gatewayPaymentId && ` · ${inv.payment.gatewayPaymentId}`}{inv.payment.paidOn && ` on ${date(inv.payment.paidOn)}`}</div>
      </div>
    </>
  );
}
