import type { GspProvider } from '@prisma/client';
import { prisma, type Tx } from '../prisma.js';
import { decryptJson } from './crypto.js';
import { MockAdapter } from './adapters/mock.js';
import { missingCredentials, NotImplementedAdapter } from './adapters/stubs.js';
import { ClearTaxAdapter } from './adapters/cleartax.js';
import { MastersIndiaAdapter } from './adapters/mastersindia.js';
import { envOf } from './adapters/http.js';
import { GspError } from './adapters/types.js';
import type { GspAdapter } from './adapters/types.js';

export * from './payload.js';
export * from './validate.js';
export * from './adapters/types.js';
export { CREDENTIAL_FIELDS } from './adapters/stubs.js';
export { encryptJson } from './crypto.js';

export async function getSettings(tenantId: string, tx: Tx = prisma) {
  return tx.einvoiceSettings.findUnique({ where: { tenantId } });
}

export function adapterFor(provider: GspProvider, credentialsEnc: string | null, gstin?: string | null): GspAdapter {
  if (provider === 'MOCK') return new MockAdapter();
  const creds = credentialsEnc ? decryptJson<Record<string, string>>(credentialsEnc) : null;
  if (provider === 'CLEARTAX' || provider === 'MASTERS_INDIA') {
    missingCredentials(provider, creds);
    if (!gstin) throw new GspError('Add your company GSTIN in Setup before using e-invoicing', 'NO_CREDENTIALS');
    return provider === 'CLEARTAX'
      ? new ClearTaxAdapter(creds as { authToken: string; ownerId?: string }, gstin.toUpperCase(), envOf(creds))
      : new MastersIndiaAdapter(creds as { username: string; password: string }, gstin.toUpperCase(), envOf(creds));
  }
  return new NotImplementedAdapter(provider, creds);
}

/** sandbox / production / offline, for the UI. */
export function providerMode(provider: GspProvider, credentialsEnc: string | null) {
  if (provider === 'MOCK') return 'offline';
  try { return envOf(credentialsEnc ? decryptJson<Record<string, string>>(credentialsEnc) : null); } catch { return 'sandbox'; }
}

export async function getAdapter(tenantId: string, need: 'einvoice' | 'ewaybill') {
  const s = await getSettings(tenantId);
  if (!s || (need === 'einvoice' ? !s.einvoiceEnabled : !s.ewaybillEnabled))
    throw Object.assign(new Error(`${need === 'einvoice' ? 'E-invoicing' : 'E-way bills'} are switched off. Turn them on in Settings → E-invoicing.`), { statusCode: 400 });
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { gstin: true } });
  return adapterFor(s.provider, s.credentialsEnc, t?.gstin);
}

/** Straight-line distance × 1.3 as a road estimate; 0 lets the portal compute PIN-to-PIN. */
export function estimateRoadKm(a?: { lat: number | null; lng: number | null } | null, b?: { lat: number | null; lng: number | null } | null) {
  if (a?.lat == null || a.lng == null || b?.lat == null || b.lng == null) return 0;
  const R = 6371, rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.max(1, Math.round(2 * R * Math.asin(Math.sqrt(h)) * 1.3));
}
