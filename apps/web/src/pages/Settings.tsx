import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, money, qty, session } from '../lib/api';
import { ErrorText, Field, PageHeader, Table, formData, useSave } from '../components/ui';

const TABS = ['Staff', 'Trucks', 'Grades', 'Materials', 'Suppliers', 'Plants', 'E-invoicing'] as const;

export default function Settings() {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Staff');
  return (
    <>
      <PageHeader title="Setup" subtitle="Staff logins, trucks, concrete grades and masters" />
      <div className="mb-5 flex flex-wrap gap-1 border-b border-slate-200">
        {TABS.map((t) => <button key={t} onClick={() => setTab(t)} className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${tab === t ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500'}`}>{t}</button>)}
      </div>
      {tab === 'Staff' && <Staff />}
      {tab === 'Trucks' && <Trucks />}
      {tab === 'Grades' && <Grades />}
      {tab === 'Materials' && <Materials />}
      {tab === 'Suppliers' && <Suppliers />}
      {tab === 'Plants' && <Plants />}
      {tab === 'E-invoicing' && <Einvoicing />}
    </>
  );
}

function Inline({ onSubmit, children, error, busy }: { onSubmit: (d: any) => void; children: React.ReactNode; error: string | null; busy: boolean }) {
  return (
    <form className="card mb-4 p-4" onSubmit={(e) => { onSubmit(formData(e)); e.currentTarget.reset(); }}>
      <div className="grid grid-cols-2 items-end gap-3 md:grid-cols-5">{children}<button className="btn-primary justify-center" disabled={busy}>Add</button></div>
      <ErrorText error={error} />
    </form>
  );
}

function Staff() {
  const { data } = useQuery({ queryKey: ['users'], queryFn: () => api('/users') });
  const save = useSave('/users', ['users']);
  const owner = session.get()?.user.role === 'OWNER';
  return (
    <>
      {owner && <Inline onSubmit={save.mutate} error={save.error} busy={save.isPending}>
        <Field label="Name"><input name="name" className="input" required /></Field>
        <Field label="Mobile (login)"><input name="phone" className="input" required minLength={10} /></Field>
        <Field label="Password"><input name="password" type="password" className="input" required minLength={8} /></Field>
        <Field label="Role"><select name="role" className="input">{['MANAGER', 'ACCOUNTANT', 'SALES', 'STORE', 'BATCHING', 'DISPATCH', 'DRIVER'].map((r) => <option key={r}>{r}</option>)}</select></Field>
      </Inline>}
      <Table rows={data} cols={[{ key: 'name', label: 'Name' }, { key: 'phone', label: 'Mobile' }, { key: 'role', label: 'Role', render: (u: any) => u.role.toLowerCase() }, { key: 'active', label: 'Active', render: (u: any) => (u.active ? 'yes' : 'no') }]} />
    </>
  );
}

function Trucks() {
  const { data } = useQuery({ queryKey: ['vehicles'], queryFn: () => api('/vehicles') });
  const save = useSave('/vehicles', ['vehicles']);
  return (
    <>
      <Inline onSubmit={save.mutate} error={save.error} busy={save.isPending}>
        <Field label="Number"><input name="number" className="input uppercase" required /></Field>
        <Field label="Type"><select name="type" className="input"><option value="TRANSIT_MIXER">Transit mixer</option><option value="PUMP">Pump</option><option value="TIPPER">Tipper</option><option value="OTHER">Other</option></select></Field>
        <Field label="Capacity (m³)"><input name="capacityM3" type="number" step="0.5" className="input" defaultValue={7} /></Field>
      </Inline>
      <Table rows={data} cols={[{ key: 'number', label: 'Number' }, { key: 'type', label: 'Type', render: (v: any) => v.type.replace('_', ' ').toLowerCase() }, { key: 'cap', label: 'Capacity', render: (v: any) => `${qty(v.capacityM3)} m³` }]} />
    </>
  );
}

function Grades() {
  const { data } = useQuery({ queryKey: ['mix-designs'], queryFn: () => api('/mix-designs') });
  return (
    <>
      <p className="mb-3 text-sm text-slate-500">Recipe per m³. Batching uses it as the design weight; owner insights compare actuals against it.</p>
      <div className="grid gap-4 md:grid-cols-3">
        {data?.map((m: any) => (
          <div key={m.id} className="card p-4">
            <div className="flex justify-between"><span className="text-lg font-semibold">{m.grade}</span><span className="text-sm">{money(m.baseRate)}/m³ · GST {Number(m.gstRate)}%</span></div>
            <div className="mt-2 space-y-0.5 text-sm">{m.items.map((i: any) => <div key={i.id} className="flex justify-between"><span className="text-slate-600">{i.material.name}</span><span className="tabular-nums">{qty(i.qtyPerM3, 1)} {i.material.unit}</span></div>)}</div>
          </div>
        ))}
      </div>
    </>
  );
}

function Materials() {
  const save = useSave('/materials', ['materials']);
  const { data } = useQuery({ queryKey: ['materials'], queryFn: () => api('/materials') });
  return (
    <>
      <Inline onSubmit={save.mutate} error={save.error} busy={save.isPending}>
        <Field label="Name"><input name="name" className="input" required /></Field>
        <Field label="Type"><select name="kind" className="input">{['CEMENT', 'FLY_ASH', 'GGBS', 'AGGREGATE_10MM', 'AGGREGATE_20MM', 'SAND', 'M_SAND', 'ADMIXTURE', 'WATER', 'OTHER'].map((k) => <option key={k}>{k}</option>)}</select></Field>
        <Field label="Unit"><select name="unit" className="input"><option>KG</option><option>TON</option><option>LTR</option><option>M3</option></select></Field>
        <Field label="Reorder level"><input name="reorderLevel" type="number" className="input" /></Field>
      </Inline>
      <Table rows={data} cols={[{ key: 'name', label: 'Material' }, { key: 'unit', label: 'Unit' }, { key: 'r', label: 'Reorder level', render: (m: any) => qty(m.reorderLevel, 0) }]} />
    </>
  );
}

function Suppliers() {
  const save = useSave('/suppliers', ['suppliers']);
  const { data } = useQuery({ queryKey: ['suppliers'], queryFn: () => api('/suppliers') });
  return (
    <>
      <Inline onSubmit={save.mutate} error={save.error} busy={save.isPending}>
        <Field label="Name"><input name="name" className="input" required /></Field>
        <Field label="GSTIN"><input name="gstin" className="input" /></Field>
        <Field label="Phone"><input name="phone" className="input" /></Field>
      </Inline>
      <Table rows={data} cols={[{ key: 'name', label: 'Supplier' }, { key: 'gstin', label: 'GSTIN' }, { key: 'phone', label: 'Phone' }]} />
    </>
  );
}

function Plants() {
  const save = useSave('/plants', ['plants']);
  const { data } = useQuery({ queryKey: ['plants'], queryFn: () => api('/plants') });
  return (
    <>
      <Inline onSubmit={save.mutate} error={save.error} busy={save.isPending}>
        <Field label="Plant name"><input name="name" className="input" required /></Field>
        <Field label="Address"><input name="address" className="input" /></Field>
        <Field label="PIN code"><input name="pincode" className="input" inputMode="numeric" pattern="[1-9][0-9]{5}" maxLength={6} /></Field>
        <Field label="Latitude"><input name="lat" type="number" step="any" className="input" /></Field>
        <Field label="Longitude"><input name="lng" type="number" step="any" className="input" /></Field>
      </Inline>
      <Table rows={data} cols={[{ key: 'name', label: 'Plant' }, { key: 'address', label: 'Address' }, { key: 'pincode', label: 'PIN' }]} />
    </>
  );
}

const PROVIDERS = [['MOCK', 'Mock (offline testing — no real IRNs)'], ['CLEARTAX', 'ClearTax GSP'], ['MASTERS_INDIA', 'Masters India GSP'], ['NIC_DIRECT', 'NIC direct API']] as const;

function Einvoicing() {
  const qc = useQueryClient();
  const role = session.get()?.user.role;
  const canEdit = role === 'OWNER' || role === 'MANAGER';
  const { data: s } = useQuery({ queryKey: ['einvoice-settings'], queryFn: () => api('/einvoice/settings') });
  const { data: co } = useQuery({ queryKey: ['company'], queryFn: () => api('/company') });
  const [form, setForm] = useState<{ einvoiceEnabled: boolean; ewaybillEnabled: boolean; provider: string } | null>(null);
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (s && !form) setForm({ einvoiceEnabled: s.einvoiceEnabled, ewaybillEnabled: s.ewaybillEnabled, provider: s.provider }); }, [s, form]);
  const save = useMutation({
    mutationFn: () => api('/einvoice/settings', { method: 'PUT', body: { ...form, credentials: creds } }),
    onSuccess: () => { setCreds({}); setError(null); setMsg('Saved'); qc.invalidateQueries({ queryKey: ['einvoice-settings'] }); },
    onError: (e: Error) => { setMsg(null); setError(e.message); },
  });
  const test = useMutation({
    mutationFn: () => api('/einvoice/test', { method: 'POST', body: {} }),
    onSuccess: (r: any) => { setError(null); setMsg(r.message); }, onError: (e: Error) => { setMsg(null); setError(e.message); },
  });
  const saveCo = useMutation({
    mutationFn: (body: any) => api('/company', { method: 'PUT', body }),
    onSuccess: () => { setError(null); setMsg('Company details saved'); qc.invalidateQueries({ queryKey: ['company'] }); },
    onError: (e: Error) => { setMsg(null); setError(e.message); },
  });
  if (!s || !form || !co) return <div className="text-slate-400">Loading…</div>;
  const fields: { key: string; label: string }[] = s.credentialFields[form.provider] ?? [];
  const providerChanged = form.provider !== s.provider;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="card p-5">
        <h3 className="mb-1 font-semibold">E-invoice &amp; e-way bill</h3>
        <p className="mb-4 text-sm text-slate-500">IRNs are generated for B2B tax invoices only. Amounts sent to the portal are exactly the amounts on the invoice.</p>
        <fieldset disabled={!canEdit} className="space-y-3">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.einvoiceEnabled} onChange={(e) => setForm({ ...form, einvoiceEnabled: e.target.checked })} />Generate e-invoices (IRN)</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.ewaybillEnabled} onChange={(e) => setForm({ ...form, ewaybillEnabled: e.target.checked })} />Generate e-way bills</label>
          <Field label="Provider (GSP)"><select className="input" value={form.provider} onChange={(e) => { setForm({ ...form, provider: e.target.value }); setCreds({}); }}>{PROVIDERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          {fields.length > 0 && <div className="space-y-3 rounded-lg bg-slate-50 p-3">
            <p className="text-xs text-slate-500">Credentials are encrypted on the server and never shown again. Leave a field blank to keep the saved value.{providerChanged && ' Changing provider clears saved credentials.'}</p>
            {!s.encryptionReady && <p className="text-xs text-red-600">The server has no EINVOICE_ENC_KEY set, so credentials cannot be saved.</p>}
            {fields.map((f) => (
              <Field key={f.key} label={`${f.label}${!providerChanged && s.savedCredentialKeys.includes(f.key) ? ' · saved' : ''}`}>
                <input className="input" type="password" autoComplete="new-password" value={creds[f.key] ?? ''} placeholder={!providerChanged && s.savedCredentialKeys.includes(f.key) ? '••••••••' : ''} onChange={(e) => setCreds({ ...creds, [f.key]: e.target.value })} />
              </Field>
            ))}
          </div>}
          <div className="flex gap-2">
            <button type="button" className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>Save</button>
            <button type="button" className="btn-ghost" disabled={test.isPending || providerChanged} onClick={() => test.mutate()} title={providerChanged ? 'Save first' : ''}>Test connection</button>
          </div>
        </fieldset>
        {!canEdit && <p className="mt-2 text-xs text-slate-400">Only the owner or a manager can change these settings.</p>}
      </div>
      <form className="card p-5" onSubmit={(e) => saveCo.mutate(formData(e))}>
        <h3 className="mb-1 font-semibold">Company details on e-invoices</h3>
        <p className="mb-4 text-sm text-slate-500">The portal checks these against your GST registration.</p>
        <fieldset disabled={role !== 'OWNER'} className="grid grid-cols-2 gap-3">
          <Field label="Legal name" className="col-span-2"><input name="legalName" className="input" defaultValue={co.legalName ?? co.name} /></Field>
          <Field label="GSTIN"><input name="gstin" className="input uppercase" maxLength={15} defaultValue={co.gstin ?? ''} /></Field>
          <Field label="State code"><input name="stateCode" className="input" maxLength={2} defaultValue={co.stateCode} /></Field>
          <Field label="Address" className="col-span-2"><input name="address" className="input" defaultValue={co.address ?? ''} /></Field>
          <Field label="City"><input name="city" className="input" defaultValue={co.city ?? ''} /></Field>
          <Field label="PIN code"><input name="pincode" className="input" maxLength={6} defaultValue={co.pincode ?? ''} /></Field>
          <Field label="Phone"><input name="phone" className="input" defaultValue={co.phone ?? ''} /></Field>
          <Field label="Email"><input name="email" className="input" defaultValue={co.email ?? ''} /></Field>
          <div className="col-span-2"><button className="btn-primary" disabled={saveCo.isPending}>Save company details</button></div>
        </fieldset>
        {role !== 'OWNER' && <p className="mt-2 text-xs text-slate-400">Only the owner can change company details.</p>}
      </form>
      {(msg || error) && <div className="lg:col-span-2">{msg && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{msg}</p>}<ErrorText error={error} /></div>}
    </div>
  );
}
