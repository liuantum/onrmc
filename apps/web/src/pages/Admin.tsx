import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api, date, money } from '../lib/api';
import { Badge, ErrorText, Field, Modal, PageHeader, Stat, Table, formData, useSave } from '../components/ui';

export default function Admin() {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<any>(null);
  const { data: stats } = useQuery({ queryKey: ['admin-stats'], queryFn: () => api('/admin/stats') });
  const { data: tenants } = useQuery({ queryKey: ['tenants'], queryFn: () => api('/admin/tenants') });
  const { data: plans } = useQuery({ queryKey: ['plans'], queryFn: () => api('/admin/plans') });
  const save = useSave('/admin/tenants', ['tenants', 'admin-stats'], () => setOpen(false));
  const saveSub = useSave(() => `/admin/tenants/${sub.id}/subscription`, ['tenants', 'admin-stats'], () => setSub(null));
  const toggle = useSave((v) => `/admin/tenants/${v.id}/active`, ['tenants']);
  return (
    <>
      <PageHeader title="Plant owners" subtitle="onrmc subscriptions" actions={<button className="btn-primary" onClick={() => setOpen(true)}><Plus size={16} />Onboard plant owner</button>} />
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Tenants" value={stats?.tenants ?? '—'} /><Stat label="Paying" value={stats?.active ?? '—'} tone="green" />
        <Stat label="On trial" value={stats?.trial ?? '—'} tone="blue" /><Stat label="MRR" value={stats ? money(stats.mrr) : '—'} tone="green" hint={stats?.pendingPayments ? `${stats.pendingPayments} payment(s) to verify` : undefined} />
      </div>
      <Table rows={tenants} cols={[
        { key: 'name', label: 'Company', render: (t: any) => <><div className="font-medium">{t.name}</div><div className="text-xs text-slate-500">{t.gstin}</div></> },
        { key: 'plan', label: 'Plan', render: (t: any) => t.subscriptions[0]?.plan.name ?? '—' },
        { key: 'status', label: 'Status', render: (t: any) => (t.subscriptions[0] ? <Badge s={t.subscriptions[0].status} /> : '—') },
        { key: 'ends', label: 'Valid till', render: (t: any) => (t.subscriptions[0] ? date(t.subscriptions[0].endsAt) : '—') },
        { key: 'usage', label: 'Usage', render: (t: any) => `${t._count.plants} plants · ${t._count.users} users · ${t._count.vehicles} trucks` },
        { key: 'a', label: '', render: (t: any) => <div className="flex gap-1"><button className="btn-ghost" onClick={() => setSub(t)}>Renew / change</button><button className={t.active ? 'btn-danger' : 'btn-ghost'} onClick={() => toggle.mutate({ id: t.id, active: !t.active })}>{t.active ? 'Suspend' : 'Reactivate'}</button></div> },
      ]} />
      <Modal title="Onboard plant owner" open={open} onClose={() => setOpen(false)}>
        <form className="grid grid-cols-2 gap-4" onSubmit={(e) => save.mutate(formData(e))}>
          <Field label="Company name" className="col-span-2"><input name="name" className="input" required /></Field>
          <Field label="GSTIN"><input name="gstin" className="input" /></Field>
          <Field label="State code"><input name="stateCode" className="input" maxLength={2} required defaultValue="36" /></Field>
          <Field label="Owner name"><input name="ownerName" className="input" required /></Field>
          <Field label="Owner mobile"><input name="ownerPhone" className="input" required /></Field>
          <Field label="Temporary password"><input name="ownerPassword" className="input" required minLength={8} /></Field>
          <Field label="Plan"><select name="planId" className="input">{plans?.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          <Field label="Trial days"><input name="trialDays" type="number" className="input" defaultValue={14} /></Field>
          <div className="col-span-2 flex justify-end"><button className="btn-primary" disabled={save.isPending}>Create</button></div>
        </form>
        <ErrorText error={save.error} />
      </Modal>
      <Modal title={`Subscription · ${sub?.name ?? ''}`} open={!!sub} onClose={() => setSub(null)}>
        <form className="grid grid-cols-2 gap-4" onSubmit={(e) => saveSub.mutate(formData(e))}>
          <Field label="Plan"><select name="planId" className="input">{plans?.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          <Field label="Status"><select name="status" className="input">{['ACTIVE', 'TRIAL', 'PAST_DUE', 'SUSPENDED', 'CANCELLED'].map((s) => <option key={s}>{s}</option>)}</select></Field>
          <Field label="Billing cycle"><select name="billingCycle" className="input"><option>MONTHLY</option><option>YEARLY</option></select></Field>
          <Field label="Months"><input name="months" type="number" className="input" defaultValue={12} /></Field>
          <div className="col-span-2 flex justify-end"><button className="btn-primary" disabled={saveSub.isPending}>Save</button></div>
        </form>
        <ErrorText error={saveSub.error} />
      </Modal>
    </>
  );
}
