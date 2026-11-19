import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { api, date, dateTime, qty } from '../lib/api';
import { Badge, PageHeader } from '../components/ui';
import { DocFooter, DocLogo } from '../components/PrintBits';

/** Printable delivery challan: travels with the truck, signed by the site on delivery. */
export default function ChallanView() {
  const { id } = useParams();
  const { data: c } = useQuery({ queryKey: ['challans', id], queryFn: () => api(`/challans/${id}`) });
  if (!c) return <div className="text-slate-400">Loading…</div>;
  const t = c.tenant, o = c.order, ewb = c.ewayBills?.[0];
  const row = (k: string, v: React.ReactNode) => <div className="flex justify-between gap-4 border-b border-slate-100 py-1.5"><span className="text-slate-500">{k}</span><span className="text-right font-medium">{v ?? '—'}</span></div>;
  return (
    <>
      <PageHeader title={c.number} subtitle="Delivery challan" actions={<><Badge s={c.status} /><button className="btn-ghost" onClick={() => print()}><Printer size={16} />Print / PDF</button></>} />
      <div className="card mx-auto max-w-3xl p-8 text-sm print:border-0 print:shadow-none">
        <div className="flex justify-between border-b border-slate-200 pb-4">
          <div className="flex items-start gap-4">
            <DocLogo src={t.logoUrl} />
            <div>
              <div className="text-xl font-bold">{t.legalName ?? t.name}</div>
              <div className="text-slate-600">{[t.address, t.city, t.pincode].filter(Boolean).join(', ')}</div>
              {t.gstin && <div>GSTIN: <b>{t.gstin}</b></div>}
              {t.phone && <div>Ph: {t.phone}</div>}
            </div>
          </div>
          <div className="text-right">
            <div className="text-lg font-semibold uppercase tracking-wide">Delivery Challan</div>
            <div>No: <b>{c.number}</b></div>
            <div>Date: {date(c.dispatchedAt ?? c.createdAt)}</div>
            <div>Order: {o.number}</div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-6 py-4">
          <div>
            <div className="text-xs uppercase text-slate-500">Customer</div>
            <div className="font-semibold">{o.customer.name}</div>
            {o.customer.gstin && <div>GSTIN {o.customer.gstin}</div>}
            {o.customer.phone && <div>Ph: {o.customer.phone}</div>}
          </div>
          <div>
            <div className="text-xs uppercase text-slate-500">Deliver to</div>
            <div className="font-semibold">{o.site.name}</div>
            <div>{[o.site.address, o.site.city, o.site.pincode].filter(Boolean).join(', ')}</div>
            {o.site.contact && <div>Contact: {o.site.contact}</div>}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-8">
          <div>
            {row('Grade', o.mixDesign.grade)}
            {row('Quantity', `${qty(c.quantityM3)} m³`)}
            {row('Batch', c.batch ? `${c.batch.number} · ${dateTime(c.batch.batchedAt)}` : null)}
            {row('Plant', c.batch?.plant?.name)}
            {row('Pump', o.pumpRequired ? 'Required' : 'No')}
          </div>
          <div>
            {row('Truck', c.vehicle.number)}
            {row('Driver', c.driver ? `${c.driver.name}${c.driver.phone ? ` · ${c.driver.phone}` : ''}` : null)}
            {row('Left plant', c.dispatchedAt ? dateTime(c.dispatchedAt) : null)}
            {row('E-way bill', ewb ? ewb.ewbNo : null)}
            {row('Invoice', c.invoiceLine?.invoice?.number)}
          </div>
        </div>
        <div className="mt-6 grid grid-cols-3 gap-4 text-xs text-slate-600">
          <div className="rounded border border-slate-200 p-2">Arrived at site<br /><br />______ : ______</div>
          <div className="rounded border border-slate-200 p-2">Unloading done<br /><br />______ : ______</div>
          <div className="rounded border border-slate-200 p-2">Slump at site (mm)<br /><br />__________</div>
        </div>
        {c.podName && <p className="mt-4">Received by <b>{c.podName}</b>{c.deliveredAt && ` on ${dateTime(c.deliveredAt)}`}.</p>}
        <div className="mt-12 flex justify-between text-slate-500"><span>Received in good condition<br /><br />Name, signature &amp; site seal</span><span className="text-right">For {t.name}<br /><br />Authorised signatory</span></div>
        <DocFooter />
      </div>
    </>
  );
}
