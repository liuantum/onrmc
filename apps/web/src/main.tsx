import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import 'leaflet/dist/leaflet.css';
import './index.css';
import { session } from './lib/api';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Orders from './pages/Orders';
import Batching from './pages/Batching';
import Dispatch from './pages/Dispatch';
import Fleet from './pages/Fleet';
import Invoices from './pages/Invoices';
import InvoiceView from './pages/InvoiceView';
import Notes from './pages/Notes';
import NoteView from './pages/NoteView';
import Suppliers from './pages/Suppliers';
import PurchaseBills, { PurchaseBillView } from './pages/PurchaseBills';
import SupplierPayments from './pages/SupplierPayments';
import Payments from './pages/Payments';
import Accounts from './pages/Accounts';
import Customers from './pages/Customers';
import Inventory from './pages/Inventory';
import Insights from './pages/Insights';
import Settings from './pages/Settings';
import Admin from './pages/Admin';
import Plans from './pages/Plans';
import Subscription, { SubscriptionInvoiceView } from './pages/Subscription';
import AdminPayments, { AdminPaymentSettings } from './pages/AdminPayments';
import { useParams } from 'react-router-dom';
import Maintenance from './pages/Maintenance';
import Qc from './pages/Qc';

const SubInvoice = () => <SubscriptionInvoiceView id={useParams().id!} />;

const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: true, retry: 1 } } });

function Protected({ children }: { children: React.ReactNode }) {
  return session.get() ? <>{children}</> : <Navigate to="/login" replace />;
}
function Home() {
  const r = session.get()?.user.role;
  if (r === 'SUPER_ADMIN') return <Navigate to="/admin" replace />;
  if (r === 'BATCHING') return <Navigate to="/batching" replace />;
  if (r === 'DISPATCH') return <Navigate to="/dispatch" replace />;
  if (r === 'STORE') return <Navigate to="/inventory" replace />;
  if (r === 'SALES') return <Navigate to="/orders" replace />;
  return <Dashboard />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<Protected><Layout /></Protected>}>
            <Route index element={<Home />} />
            <Route path="orders" element={<Orders />} />
            <Route path="batching" element={<Batching />} />
            <Route path="dispatch" element={<Dispatch />} />
            <Route path="fleet" element={<Fleet />} />
            <Route path="maintenance" element={<Maintenance />} />
            <Route path="qc" element={<Qc />} />
            <Route path="invoices" element={<Invoices />} />
            <Route path="invoices/:id" element={<InvoiceView />} />
            <Route path="notes" element={<Notes />} />
            <Route path="notes/:id" element={<NoteView />} />
            <Route path="suppliers" element={<Suppliers />} />
            <Route path="purchase-bills" element={<PurchaseBills />} />
            <Route path="purchase-bills/:id" element={<PurchaseBillView />} />
            <Route path="supplier-payments" element={<SupplierPayments />} />
            <Route path="payments" element={<Payments />} />
            <Route path="accounts" element={<Accounts />} />
            <Route path="customers" element={<Customers />} />
            <Route path="inventory" element={<Inventory />} />
            <Route path="insights" element={<Insights />} />
            <Route path="settings" element={<Settings />} />
            <Route path="admin" element={<Admin />} />
            <Route path="admin/plans" element={<Plans />} />
            <Route path="admin/payments" element={<AdminPayments />} />
            <Route path="admin/payment-settings" element={<AdminPaymentSettings />} />
            <Route path="subscription" element={<Subscription />} />
            <Route path="subscription/invoices/:id" element={<SubInvoice />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
