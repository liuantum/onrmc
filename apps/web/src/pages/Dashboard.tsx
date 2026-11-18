import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, money, qty } from '../lib/api';
import { PageHeader, Stat } from '../components/ui';

export default function Dashboard() {
  const { data } = useQuery({ queryKey: ['dashboard'], queryFn: () => api('/analytics/dashboard'), refetchInterval: 30_000 });
  const t = data?.today;
  return (
    <>
      <PageHeader title="Today" subtitle={new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Produced" value={t ? `${qty(t.producedM3)} m³` : '—'} />
        <Stat label="Delivered" value={t ? `${qty(t.deliveredM3)} m³` : '—'} hint={t ? `${t.trips} trips` : ''} />
        <Stat label="Billed today" value={t ? money(t.sales) : '—'} tone="blue" />
        <Stat label="Collected today" value={t ? money(t.collections) : '—'} tone="green" />
        <Stat label="Total receivable" value={data ? money(data.receivable) : '—'} tone="amber" />
        <Stat label="Trucks on road" value={data?.activeTrips ?? '—'} />
        <Stat label="Open orders" value={data?.pendingOrders ?? '—'} />
        <Stat label="Low stock items" value={data?.lowStock.length ?? '—'} tone={data?.lowStock.length ? 'red' : 'slate'} />
      </div>
      {data?.lowStock.length > 0 && (
        <div className="card mt-6 border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <b>Reorder needed:</b> {data.lowStock.map((m: any) => `${m.name} (${qty(m.quantity, 0)} left)`).join(', ')} · <Link to="/inventory" className="underline">Open stock</Link>
        </div>
      )}
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <Link to="/orders" className="card p-5 hover:border-brand-500"><div className="font-semibold">New order</div><div className="text-sm text-slate-500">Book concrete for a customer site</div></Link>
        <Link to="/invoices" className="card p-5 hover:border-brand-500"><div className="font-semibold">Bill delivered challans</div><div className="text-sm text-slate-500">Create GST invoices in two clicks</div></Link>
        <Link to="/payments" className="card p-5 hover:border-brand-500"><div className="font-semibold">Record a payment</div><div className="text-sm text-slate-500">Auto-settles oldest invoices first</div></Link>
      </div>
    </>
  );
}
