import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { requireRole, tid } from '../lib/auth.js';
import { adapterFor, getSettings, gstinError, GspError, STATE_CODES, type GstinDetails } from '../lib/einvoice/index.js';
import { decryptJson } from '../lib/einvoice/crypto.js';
import { MastersIndiaAdapter } from '../lib/einvoice/adapters/mastersindia.js';
import { envOf } from '../lib/einvoice/adapters/http.js';
import { platformSettings } from '../lib/subscription.js';

/** 4th PAN character → kind of taxpayer. */
const PAN_KIND: Record<string, string> = {
  C: 'Company', P: 'Individual / proprietor', F: 'Partnership firm / LLP', H: 'HUF', A: 'Association of persons', T: 'Trust',
  B: 'Body of individuals', L: 'Local authority', J: 'Artificial juridical person', G: 'Government',
};

const cache = new Map<string, { at: number; d: GstinDetails | null }>();
const DAY = 864e5;
export const clearGstinCache = () => cache.clear();

/**
 * onrmc's own Masters India account, set once by the super admin, so every plant gets name / address
 * lookups without an account of its own. Returns undefined when it isn't set up or is switched off.
 */
export async function platformGstinDetails(gstin: string, ignoreSwitch = false): Promise<GstinDetails | null | undefined> {
  const ps = await platformSettings();
  if ((!ps.gstinLookupEnabled && !ignoreSwitch) || !ps.gstinLookupEnc || !ps.gstinLookupGstin) {
    if (ignoreSwitch) throw new GspError('Save the Masters India GSTIN, username and password first', 'NO_CREDENTIALS');
    return undefined;
  }
  const c = decryptJson<Record<string, string>>(ps.gstinLookupEnc);
  if (!c.username || !c.password) throw new GspError('Masters India username or password is missing', 'NO_CREDENTIALS');
  return new MastersIndiaAdapter({ username: c.username, password: c.password, clientId: c.clientId, clientSecret: c.clientSecret }, ps.gstinLookupGstin, envOf(c)).gstinDetails(gstin);
}

/**
 * Everything onrmc can learn from a GSTIN.
 * - Always, offline: check digit, state, PAN and kind of entity (all encoded in the GSTIN itself).
 * - If this plant already has a customer / supplier with it: their saved details.
 * - If a GSP is connected (Masters India today): legal name, trade name, address, PIN and status from the GST system.
 */
export async function lookupGstin(tenantId: string, raw: string) {
  const gstin = raw.trim().toUpperCase();
  const error = gstinError(gstin, '');
  const base = {
    gstin, valid: !error, error: error?.replace(/^ GSTIN/, 'GSTIN') ?? null,
    stateCode: /^\d{2}/.test(gstin) && STATE_CODES[gstin.slice(0, 2)] ? gstin.slice(0, 2) : null,
    stateName: STATE_CODES[gstin.slice(0, 2)] ?? null,
    pan: gstin.length >= 12 ? gstin.slice(2, 12) : null, entityType: PAN_KIND[gstin[5]] ?? null,
  };
  if (error) return { ...base, details: null, source: null, existing: null, note: null };

  const [cust, supp] = await Promise.all([
    prisma.customer.findFirst({ where: { tenantId, gstin }, select: { id: true, name: true, billingAddress: true, city: true, pincode: true, stateCode: true, phone: true, email: true } }),
    prisma.supplier.findFirst({ where: { tenantId, gstin }, select: { id: true, name: true, address: true, city: true, pincode: true, stateCode: true, phone: true, email: true } }),
  ]);
  const existing = cust ? { kind: 'customer' as const, id: cust.id, name: cust.name } : supp ? { kind: 'supplier' as const, id: supp.id, name: supp.name } : null;

  let details: GstinDetails | null = null, source: string | null = null, note: string | null = null;
  const hit = cache.get(gstin);
  if (hit && Date.now() - hit.at < DAY) { details = hit.d; source = details ? 'gst' : null; }
  else {
    const s = await getSettings(tenantId);
    const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { gstin: true } });
    let answered = false;
    try {
      // 1. the plant's own GSP, if it has one that can look up GSTINs
      let a = null;
      try { a = s ? adapterFor(s.provider, s.credentialsEnc, t?.gstin) : null; } catch { a = null; }
      if (a?.gstinDetails) { details = await a.gstinDetails(gstin); answered = true; }
    } catch (e) { note = e instanceof GspError ? `GST lookup failed: ${e.message}` : 'GST lookup failed'; }
    if (!answered) {
      // 2. onrmc's platform account
      try {
        const d = await platformGstinDetails(gstin);
        if (d !== undefined) { details = d; answered = true; note = null; }
      } catch (e) { note = e instanceof GspError ? `GST lookup failed: ${e.message}` : 'GST lookup failed'; }
    }
    if (answered) {
      cache.set(gstin, { at: Date.now(), d: details });
      source = details ? 'gst' : null;
      if (!details) note = 'The GST system has no record of this GSTIN. Check it with the customer.';
    } else if (!note) note = 'Name and address lookups are not switched on yet. State and PAN are filled from the GSTIN.';
  }
  const saved = cust ? { name: cust.name, address: cust.billingAddress, city: cust.city, pincode: cust.pincode, phone: cust.phone, email: cust.email }
    : supp ? { name: supp.name, address: supp.address, city: supp.city, pincode: supp.pincode, phone: supp.phone, email: supp.email } : null;
  if (!details && saved) { source = 'saved'; note = null; }
  return { ...base, details, saved, source, existing, note };
}

export default async function (app: FastifyInstance) {
  app.get('/gstin/:gstin', { preHandler: requireRole('MANAGER', 'ACCOUNTANT', 'SALES', 'DISPATCH', 'STORE') }, async (req) =>
    lookupGstin(tid(req), (req.params as { gstin: string }).gstin));
}
