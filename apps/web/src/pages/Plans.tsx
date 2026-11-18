import { useQuery } from '@tanstack/react-query';
import { api, money } from '../lib/api';
import { ErrorText, Field, PageHeader, formData, useSave } from '../components/ui';

export default function Plans() {
  const { data } = useQuery({ queryKey: ['plans'], queryFn: () => api('/admin/plans') });
  const save = useSave('/admin/plans', ['plans']);
  return (
    <>
      <PageHeader title="Subscription plans" />
      <div className="mb-8 grid gap-4 md:grid-cols-3">
        {data?.map((p: any) => (
          <div key={p.id} className="card p-5">
            <div className="text-lg font-semibold">{p.name}</div>
            <div className="mt-1 text-2xl font-bold text-brand-700">{money(p.priceMonthly)}<span className="text-sm font-normal text-slate-500">/month</span></div>
            <div className="text-sm text-slate-500">{money(p.priceYearly)}/year</div>
            <ul className="mt-3 space-y-1 text-sm"><li>{p.maxPlants} plant(s)</li><li>{p.maxUsers} users</li><li>{p.maxVehicles} trucks</li>{p.features.map((f: string) => <li key={f}>✓ {f.replace('_', ' ')}</li>)}</ul>
          </div>
        ))}
      </div>
      <form className="card grid grid-cols-2 gap-4 p-5 md:grid-cols-4" onSubmit={(e) => { const d = formData(e); save.mutate({ ...d, features: String(d.features ?? '').split(',').map((s) => s.trim()).filter(Boolean) }); }}>
        <Field label="Plan name"><input name="name" className="input" required /></Field>
        <Field label="Monthly ₹"><input name="priceMonthly" type="number" className="input" required /></Field>
        <Field label="Yearly ₹"><input name="priceYearly" type="number" className="input" required /></Field>
        <Field label="Plants"><input name="maxPlants" type="number" className="input" defaultValue={1} /></Field>
        <Field label="Users"><input name="maxUsers" type="number" className="input" defaultValue={10} /></Field>
        <Field label="Trucks"><input name="maxVehicles" type="number" className="input" defaultValue={10} /></Field>
        <Field label="Features (comma separated)" className="col-span-2"><input name="features" className="input" placeholder="billing, accounts, gps, owner_app, analytics" /></Field>
        <div className="col-span-full flex justify-end"><button className="btn-primary" disabled={save.isPending}>Add plan</button></div>
        <ErrorText error={save.error} />
      </form>
    </>
  );
}
