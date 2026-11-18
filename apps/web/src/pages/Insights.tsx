import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { api, money, qty } from '../lib/api';
import { PageHeader, Stat, Table } from '../components/ui';

/** Owner-only. Real cost and margin from the same books customers and GST see. */
export default function Insights() {
  const first = new Date(); first.setDate(1);
  const [from, setFrom] = useState(first.toISOString().slice(0, 10));
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const { data } = useQuery({ queryKey: ['margin', from, to], queryFn: () => api(`/analytics/margin?from=${from}&to=${to}`) });
  const t = data?.totals;
  const cols = [
    { key: 'key', label: 'Name' },
    { key: 'm3', label: 'm³', align: 'right' as const, render: (r: any) => qty(r.m3) },
    { key: 'revenue', label: 'Revenue', align: 'right' as const, render: (r: any) => money(r.revenue) },
    { key: 'rpm', label: '₹/m³ sold', align: 'right' as const, render: (r: any) => money(r.revenuePerM3) },
    { key: 'cpm', label: '₹/m³ cost', align: 'right' as const, render: (r: any) => money(r.costPerM3) },
    { key: 'diesel', label: 'Diesel', align: 'right' as const, render: (r: any) => (r.diesel ? money(r.diesel) : '—') },
    { key: 'margin', label: 'Gross margin', align: 'right' as const, render: (r: any) => <span className={r.margin < 0 ? 'text-red-600' : 'text-emerald-700'}>{money(r.margin)} · {r.marginPct.toFixed(1)}%</span> },
  ];
  return (
    <>
      <PageHeader title="Owner insights" subtitle="Only you can see this page" actions={<>
        <input type="date" className="input w-40" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" className="input w-40" value={to} onChange={(e) => setTo(e.target.value)} />
      </>} />
      <div className="mb-2 flex items-center gap-2 text-xs text-slate-500"><Lock size={12} />Same books as Accounts → Profit &amp; loss for these dates: sales net of credit/debit notes, materials consumed (weighted average), challan diesel and booked expenses.</div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Revenue (ex-GST)" value={t ? money(t.revenue) : '—'} hint={t ? `${qty(t.m3)} m³ billed` : ''} tone="blue" />
        <Stat label="Direct cost" value={t ? money(t.cost) : '—'} hint={t ? `Materials ${money(t.materialCost)} · diesel ${money(t.diesel)}` : ''} />
        <Stat label="Gross margin" value={t ? money(t.margin) : '—'} hint={t ? `${t.marginPct.toFixed(1)}% · ${money(t.margin / (t.m3 || 1))}/m³` : ''} tone={t?.margin >= 0 ? 'green' : 'red'} />
        <Stat label="After overheads" value={data ? money(data.netAfterOverhead) : '—'} hint={data ? `Overheads ${money(data.overhead)}` : ''} tone={data?.netAfterOverhead >= 0 ? 'green' : 'red'} />
      </div>
      <h2 className="mb-2 mt-8 text-sm font-semibold text-slate-600">By customer</h2>
      <Table rows={data?.byCustomer.map((r: any) => ({ ...r, id: r.key }))} cols={cols} />
      <h2 className="mb-2 mt-8 text-sm font-semibold text-slate-600">By grade</h2>
      <Table rows={data?.byGrade.map((r: any) => ({ ...r, id: r.key }))} cols={cols} />
      <h2 className="mb-2 mt-8 text-sm font-semibold text-slate-600">Material variance (actual vs design)</h2>
      <Table rows={data?.wastage.map((r: any) => ({ ...r, id: r.material }))} cols={[
        { key: 'material', label: 'Material' },
        { key: 'design', label: 'Design', align: 'right', render: (r: any) => qty(r.design, 0) },
        { key: 'actual', label: 'Actual', align: 'right', render: (r: any) => qty(r.actual, 0) },
        { key: 'pct', label: 'Variance', align: 'right', render: (r: any) => `${(((r.actual - r.design) / (r.design || 1)) * 100).toFixed(2)}%` },
        { key: 'extraCost', label: 'Cost impact', align: 'right', render: (r: any) => <span className={r.extraCost > 0 ? 'text-red-600' : 'text-emerald-700'}>{money(r.extraCost)}</span> },
      ]} />
    </>
  );
}
