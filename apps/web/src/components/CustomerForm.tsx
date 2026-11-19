import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { ErrorText, Field, formData } from './ui';
import { GstinField } from './GstinField';

/** Add-customer form, GSTIN first so the rest fills itself. withSite also creates the first delivery site. */
export function CustomerForm({ onSaved, withSite }: { onSaved: (c: any) => void; withSite?: boolean }) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    const { siteName, ...d } = formData(e);
    setErr(null); setBusy(true);
    try {
      const c = await api('/customers', { body: d });
      if (withSite && siteName) await api(`/customers/${c.id}/sites`, { body: { name: siteName, address: d.billingAddress, city: d.city, pincode: d.pincode, stateCode: d.stateCode } });
      await qc.invalidateQueries({ queryKey: ['customers'] });
      onSaved(c);
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }
  return (
    <form className="grid grid-cols-2 gap-4" onSubmit={submit}>
      <div className="col-span-2"><GstinField label="GSTIN (if registered)" fill={{ name: 'name', address: 'billingAddress', city: 'city', pincode: 'pincode', stateCode: 'stateCode', phone: 'phone', email: 'email' }} /></div>
      <Field label="Name" className="col-span-2"><input name="name" className="input" required /></Field>
      <Field label="Phone"><input name="phone" className="input" /></Field>
      <Field label="Email"><input name="email" type="email" className="input" /></Field>
      <Field label="Billing address" className="col-span-2"><input name="billingAddress" className="input" /></Field>
      <Field label="City"><input name="city" className="input" /></Field>
      <Field label="PIN code"><input name="pincode" className="input" inputMode="numeric" pattern="[1-9][0-9]{5}" maxLength={6} title="6-digit PIN code" /></Field>
      <Field label="State code"><input name="stateCode" className="input" maxLength={2} defaultValue="36" required /></Field>
      <Field label="Credit days"><input name="creditDays" type="number" className="input" defaultValue={30} /></Field>
      <Field label="Credit limit (₹)"><input name="creditLimit" type="number" className="input" defaultValue={0} /></Field>
      {withSite && <Field label="First delivery site (same address)"><input name="siteName" className="input" placeholder="e.g. Kokapet tower B" /></Field>}
      <div className="col-span-2 flex justify-end"><button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save customer'}</button></div>
      <div className="col-span-2"><ErrorText error={err} /></div>
    </form>
  );
}
