import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { BarChart3, Boxes, Building2, ClipboardList, CreditCard, FileMinus, FileText, HandCoins, Receipt, Store, Gauge, LogOut, Map, Factory, Truck, Users, Wallet, Crown, Settings } from 'lucide-react';
import { session } from '../lib/api';

const NAV = [
  { to: '/', label: 'Dashboard', icon: Gauge, roles: ['OWNER', 'MANAGER', 'ACCOUNTANT'] },
  { to: '/orders', label: 'Orders', icon: ClipboardList, roles: ['OWNER', 'MANAGER', 'SALES', 'DISPATCH', 'BATCHING'] },
  { to: '/batching', label: 'Mixing / Batching', icon: Factory, roles: ['OWNER', 'MANAGER', 'BATCHING'] },
  { to: '/dispatch', label: 'Dispatch', icon: Truck, roles: ['OWNER', 'MANAGER', 'DISPATCH'] },
  { to: '/fleet', label: 'Live fleet', icon: Map, roles: ['OWNER', 'MANAGER', 'DISPATCH'] },
  { to: '/invoices', label: 'Billing', icon: FileText, roles: ['OWNER', 'MANAGER', 'ACCOUNTANT', 'SALES'] },
  { to: '/notes', label: 'Credit / debit notes', icon: FileMinus, roles: ['OWNER', 'MANAGER', 'ACCOUNTANT'] },
  { to: '/purchase-bills', label: 'Purchase bills', icon: Receipt, roles: ['OWNER', 'MANAGER', 'ACCOUNTANT'] },
  { to: '/supplier-payments', label: 'Supplier payments', icon: HandCoins, roles: ['OWNER', 'MANAGER', 'ACCOUNTANT'] },
  { to: '/suppliers', label: 'Suppliers', icon: Store, roles: ['OWNER', 'MANAGER', 'ACCOUNTANT'] },
  { to: '/payments', label: 'Payments', icon: CreditCard, roles: ['OWNER', 'MANAGER', 'ACCOUNTANT'] },
  { to: '/accounts', label: 'Accounts', icon: Wallet, roles: ['OWNER', 'MANAGER', 'ACCOUNTANT'] },
  { to: '/customers', label: 'Customers', icon: Users, roles: ['OWNER', 'MANAGER', 'SALES', 'ACCOUNTANT'] },
  { to: '/inventory', label: 'Aggregates & stock', icon: Boxes, roles: ['OWNER', 'MANAGER', 'STORE', 'BATCHING'] },
  { to: '/insights', label: 'Owner insights', icon: BarChart3, roles: ['OWNER'] },
  { to: '/settings', label: 'Setup', icon: Settings, roles: ['OWNER', 'MANAGER'] },
  { to: '/admin', label: 'Tenants', icon: Building2, roles: ['SUPER_ADMIN'] },
  { to: '/admin/plans', label: 'Plans', icon: Crown, roles: ['SUPER_ADMIN'] },
];

export default function Layout() {
  const s = session.get()!;
  const nav = useNavigate();
  return (
    <div className="flex min-h-screen">
      <aside className="no-print sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="px-5 py-5">
          <div className="text-xl font-bold tracking-tight text-brand-700">onrmc</div>
          <div className="truncate text-xs text-slate-500">{s.user.tenantName ?? 'Platform admin'}</div>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3">
          {NAV.filter((n) => n.roles.includes(s.user.role)).map((n) => (
            <NavLink key={n.to} to={n.to} end className={({ isActive }) => `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${isActive ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-50'}`}>
              <n.icon size={17} />{n.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-slate-100 p-3">
          <div className="px-3 text-sm font-medium">{s.user.name}</div>
          <div className="px-3 text-xs text-slate-400">{s.user.role.toLowerCase()}</div>
          <button className="btn-ghost mt-2 w-full" onClick={() => { session.set(null); nav('/login'); }}><LogOut size={16} />Sign out</button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 md:hidden">
          <span className="font-bold text-brand-700">onrmc</span>
          <select className="input w-44" onChange={(e) => nav(e.target.value)} defaultValue="">
            <option value="" disabled>Go to…</option>
            {NAV.filter((n) => n.roles.includes(s.user.role)).map((n) => <option key={n.to} value={n.to}>{n.label}</option>)}
          </select>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 p-4 md:p-8"><Outlet /></main>
      </div>
    </div>
  );
}
