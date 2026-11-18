import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireRole, tid } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { bad, HttpError, notFound } from '../lib/errors.js';
import {
  adapterFor, providerMode, buildIrpPayload, CREDENTIAL_FIELDS, EinvoiceValidationError, encryptJson, estimateRoadKm, getAdapter, getSettings,
  GspError, invoiceForIrp, irpDate, normaliseVehicleNo, notRequiredReason, pincodeError, stateError, gstinError, vehicleNoError,
} from '../lib/einvoice/index.js';
import { decryptJson } from '../lib/einvoice/crypto.js';

const idParam = (req: { params: unknown }) => (req.params as { id: string }).id;
const DAY = 24 * 3600e3;
const reasonCode = z.enum(['1', '2', '3', '4']);

/** Turns provider / validation failures into clean 4xx/5xx responses. */
function asHttp(e: unknown): Error {
  if (e instanceof EinvoiceValidationError) return new HttpError(422, `Cannot send to the portal: ${e.problems.join('; ')}`);
  if (e instanceof GspError) return new HttpError(e.code === 'NO_CREDENTIALS' || e.code === 'NOT_IMPLEMENTED' || e.code === 'AUTH' ? 400 : 502, `Portal error${e.code ? ` ${e.code}` : ''}: ${e.message}`);
  return e as Error;
}

async function loadInvoice(req: FastifyRequest) {
  const inv = await prisma.invoice.findFirst({ where: { id: idParam(req), tenantId: tid(req) }, ...invoiceForIrp });
  if (!inv) throw notFound('Invoice not found');
  return inv;
}

export default async function (app: FastifyInstance) {
  const billing = { preHandler: requireRole('MANAGER', 'ACCOUNTANT') };

  // ───── Settings (credentials are write-only) ─────
  app.get('/einvoice/settings', { preHandler: requireRole('MANAGER', 'ACCOUNTANT') }, async (req) => {
    const s = await getSettings(tid(req));
    const provider = s?.provider ?? 'MOCK';
    let savedKeys: string[] = [];
    if (s?.credentialsEnc) { try { savedKeys = Object.keys(decryptJson(s.credentialsEnc)); } catch { savedKeys = []; } }
    return {
      einvoiceEnabled: s?.einvoiceEnabled ?? false, ewaybillEnabled: s?.ewaybillEnabled ?? false, provider,
      credentialFields: CREDENTIAL_FIELDS, savedCredentialKeys: savedKeys, mode: providerMode(provider, s?.credentialsEnc ?? null), encryptionReady: (process.env.EINVOICE_ENC_KEY?.length ?? 0) >= 16,
    };
  });

  app.put('/einvoice/settings', { preHandler: requireRole('MANAGER') }, async (req) => {
    const b = z.object({
      einvoiceEnabled: z.boolean(), ewaybillEnabled: z.boolean(), provider: z.enum(['MOCK', 'CLEARTAX', 'MASTERS_INDIA', 'NIC_DIRECT']),
      /** Only non-empty values are saved; omitted keys keep their stored value. */
      credentials: z.record(z.string(), z.string()).optional(),
    }).parse(req.body);
    const t = tid(req);
    const cur = await getSettings(t);
    let credentialsEnc = cur?.credentialsEnc ?? null;
    const incoming = Object.fromEntries(Object.entries(b.credentials ?? {}).filter(([, v]) => v.trim() !== ''));
    if (cur && cur.provider !== b.provider) credentialsEnc = null; // credentials belong to one provider
    if (Object.keys(incoming).length) {
      const prev = credentialsEnc ? decryptJson<Record<string, string>>(credentialsEnc) : {};
      try { credentialsEnc = encryptJson({ ...prev, ...incoming }); } catch (e) { throw bad((e as Error).message); }
    }
    await prisma.einvoiceSettings.upsert({
      where: { tenantId: t },
      create: { tenantId: t, einvoiceEnabled: b.einvoiceEnabled, ewaybillEnabled: b.ewaybillEnabled, provider: b.provider, credentialsEnc },
      update: { einvoiceEnabled: b.einvoiceEnabled, ewaybillEnabled: b.ewaybillEnabled, provider: b.provider, credentialsEnc },
    });
    // never log secret values — only which fields changed
    await audit(req, 'UPDATE', 'EinvoiceSettings', t, { einvoiceEnabled: b.einvoiceEnabled, ewaybillEnabled: b.ewaybillEnabled, provider: b.provider, credentialKeysUpdated: Object.keys(incoming) });
    return { ok: true };
  });

  app.post('/einvoice/test', { preHandler: requireRole('MANAGER') }, async (req) => {
    const s = await getSettings(tid(req));
    const t = await prisma.tenant.findUnique({ where: { id: tid(req) }, select: { gstin: true } });
    try { return await adapterFor(s?.provider ?? 'MOCK', s?.credentialsEnc ?? null, t?.gstin).testConnection(); } catch (e) { throw asHttp(e); }
  });

  // ───── Seller details needed on e-invoices ─────
  app.get('/company', { preHandler: requireRole('MANAGER', 'ACCOUNTANT') }, async (req) =>
    prisma.tenant.findUniqueOrThrow({ where: { id: tid(req) }, select: { name: true, legalName: true, gstin: true, stateCode: true, address: true, city: true, pincode: true, phone: true, email: true } }));

  app.put('/company', { preHandler: requireRole('OWNER') }, async (req) => {
    const b = z.object({
      legalName: z.string().min(2).optional(), gstin: z.string().optional().nullable(), stateCode: z.string().length(2).optional(),
      address: z.string().optional().nullable(), city: z.string().optional().nullable(), pincode: z.string().optional().nullable(),
      phone: z.string().optional().nullable(), email: z.string().optional().nullable(),
    }).parse(req.body);
    if (b.gstin) { const e = gstinError(b.gstin, 'Company'); if (e) throw bad(e); b.gstin = b.gstin.toUpperCase(); }
    if (b.pincode) { const e = pincodeError(b.pincode, 'Company'); if (e) throw bad(e); }
    if (b.stateCode) { const e = stateError(b.stateCode, 'Company'); if (e) throw bad(e); }
    await prisma.tenant.update({ where: { id: tid(req) }, data: b });
    await audit(req, 'UPDATE', 'Tenant', tid(req), b);
    return { ok: true };
  });

  // ───── IRN ─────
  /** Shows the exact JSON that would be sent, or the list of problems to fix first. */
  app.get('/invoices/:id/einvoice/preview', billing, async (req) => {
    const inv = await loadInvoice(req);
    try { return { ok: true, payload: buildIrpPayload(inv) }; } catch (e) {
      if (e instanceof EinvoiceValidationError) return { ok: false, problems: e.problems };
      throw e;
    }
  });

  app.post('/invoices/:id/einvoice', billing, async (req) => {
    const inv = await loadInvoice(req);
    const nr = notRequiredReason(inv);
    if (nr) throw bad(nr);
    if (inv.einvoiceStatus === 'GENERATED') throw bad(`IRN already generated (${inv.irn})`);
    if (inv.einvoiceStatus === 'CANCELLED') throw bad('The IRN for this invoice was cancelled. The IRP does not allow the same invoice number again — cancel this invoice and issue a new one.');
    const adapter = await getAdapter(tid(req), 'einvoice').catch((e) => { throw asHttp(e); });
    try {
      const payload = buildIrpPayload(inv);
      let r;
      try { r = await adapter.generateIrn(payload); } catch (e) {
        // Duplicate: the IRP already has an IRN for this doc (e.g. a timed-out earlier attempt) — fetch it.
        if (e instanceof GspError && e.code === '2150') r = await adapter.getIrnByDocNo('INV', inv.number, irpDate(inv.issueDate));
        if (!r) throw e;
      }
      await prisma.invoice.update({ where: { id: inv.id }, data: { einvoiceStatus: 'GENERATED', irn: r.irn, ackNo: r.ackNo, ackDate: r.ackDate, signedQr: r.signedQr, signedInvoice: r.signedInvoice, einvoiceError: null } });
      await audit(req, 'EINVOICE_GENERATE', 'Invoice', inv.id, { provider: adapter.name, irn: r.irn, ackNo: r.ackNo, total: payload.ValDtls.TotInvVal });
      return { ok: true, irn: r.irn, ackNo: r.ackNo, ackDate: r.ackDate };
    } catch (e) {
      const err = asHttp(e);
      await prisma.invoice.update({ where: { id: inv.id }, data: { einvoiceStatus: 'FAILED', einvoiceError: err.message.slice(0, 1000) } });
      await audit(req, 'EINVOICE_FAILED', 'Invoice', inv.id, { provider: adapter.name, error: err.message });
      throw err;
    }
  });

  app.post('/invoices/:id/einvoice/cancel', billing, async (req) => {
    const b = z.object({ reasonCode: reasonCode, remark: z.string().min(3).max(100) }).parse(req.body);
    const inv = await loadInvoice(req);
    if (inv.einvoiceStatus !== 'GENERATED' || !inv.irn) throw bad('This invoice has no active IRN');
    if (inv.ackDate && Date.now() - inv.ackDate.getTime() > DAY) throw bad('IRNs can be cancelled only within 24 hours. Issue a credit note against this invoice instead.');
    const activeEwb = await prisma.ewayBill.count({ where: { invoiceId: inv.id, status: 'ACTIVE' } });
    if (activeEwb) throw bad('Cancel the active e-way bill first — the IRP does not allow cancelling an IRN with an active e-way bill.');
    const adapter = await getAdapter(tid(req), 'einvoice').catch((e) => { throw asHttp(e); });
    try {
      const r = await adapter.cancelIrn(inv.irn, b.reasonCode, b.remark);
      await prisma.invoice.update({ where: { id: inv.id }, data: { einvoiceStatus: 'CANCELLED', irnCancelledAt: r.cancelledAt, irnCancelReason: `${b.reasonCode}: ${b.remark}` } });
      await audit(req, 'EINVOICE_CANCEL', 'Invoice', inv.id, { irn: inv.irn, reasonCode: b.reasonCode, remark: b.remark });
      return { ok: true };
    } catch (e) { throw asHttp(e); }
  });

  // ───── E-way bill (generated from the IRN) ─────
  async function ewbDefaults(req: FastifyRequest) {
    const inv = await loadInvoice(req);
    const challans = inv.lines.flatMap((l) => (l.challan ? [l.challan] : []));
    const { challanId } = req.query as { challanId?: string };
    const ch = challans.find((c) => c.id === challanId) ?? challans[0];
    const plant = ch?.batch?.plant, site = ch?.order.site;
    return {
      inv, ch, plant, site,
      defaults: {
        challanId: ch?.id ?? null,
        challans: challans.map((c) => ({ id: c.id, number: c.number, vehicleNo: c.vehicle.number })),
        vehicleNo: ch?.vehicle.number ?? '',
        distanceKm: estimateRoadKm(plant, site),
        fromPin: plant?.pincode ?? inv.tenant.pincode ?? null,
        toPin: site?.pincode ?? inv.customer.pincode ?? null,
        transMode: '1',
      },
    };
  }

  app.get('/invoices/:id/ewaybill/defaults', billing, async (req) => (await ewbDefaults(req)).defaults);

  app.post('/invoices/:id/ewaybill', billing, async (req) => {
    const b = z.object({
      challanId: z.string().optional(), vehicleNo: z.string().optional(), distanceKm: z.number().int().min(0).max(4000).optional(),
      transMode: z.enum(['1', '2', '3', '4']).default('1'),
    }).parse(req.body ?? {});
    (req.query as Record<string, string>).challanId = b.challanId ?? '';
    const { inv, ch, defaults: d } = await ewbDefaults(req);
    if (inv.einvoiceStatus !== 'GENERATED' || !inv.irn) throw bad('Generate the IRN first — the e-way bill is created from it');
    if (await prisma.ewayBill.count({ where: { invoiceId: inv.id, status: 'ACTIVE' } })) throw bad('This invoice already has an active e-way bill');
    const vehicleNo = normaliseVehicleNo(b.vehicleNo || d.vehicleNo);
    const ve = vehicleNoError(vehicleNo); if (ve) throw bad(ve);
    const fromPin = d.fromPin, toPin = d.toPin;
    const pe = pincodeError(fromPin, 'Dispatch (plant)') ?? pincodeError(toPin, 'Delivery site'); if (pe) throw bad(pe);
    const distanceKm = b.distanceKm ?? d.distanceKm;
    const adapter = await getAdapter(tid(req), 'ewaybill').catch((e) => { throw asHttp(e); });
    try {
      const r = await adapter.generateEwbByIrn({
        irn: inv.irn, distanceKm, transMode: b.transMode, vehicleNo, vehicleType: 'R',
        fromPin: Number(fromPin), fromState: inv.tenant.stateCode, toPin: Number(toPin), toState: inv.placeOfSupply,
      });
      const ewb = await prisma.ewayBill.create({ data: {
        tenantId: tid(req), invoiceId: inv.id, challanId: ch?.id ?? null, ewbNo: r.ewbNo, ewbDate: r.ewbDate, validUpto: r.validUpto,
        vehicleNo, transMode: b.transMode, distanceKm, raw: (r.raw ?? undefined) as object | undefined,
      } });
      await audit(req, 'EWAYBILL_GENERATE', 'EwayBill', ewb.id, { invoice: inv.number, ewbNo: r.ewbNo, vehicleNo, distanceKm, provider: adapter.name });
      return ewb;
    } catch (e) { throw asHttp(e); }
  });

  async function loadEwb(req: FastifyRequest) {
    const e = await prisma.ewayBill.findFirst({ where: { id: idParam(req), tenantId: tid(req) }, include: { invoice: { include: { tenant: true } } } });
    if (!e) throw notFound('E-way bill not found');
    if (e.status !== 'ACTIVE') throw bad('E-way bill is cancelled');
    return e;
  }

  /** Part-B update: change of vehicle (breakdown, transhipment…). */
  app.patch('/ewaybill/:id/vehicle', billing, async (req) => {
    const b = z.object({ vehicleNo: z.string(), reasonCode: reasonCode.default('1'), remark: z.string().min(3).max(50), fromPlace: z.string().optional() }).parse(req.body);
    const e = await loadEwb(req);
    const vehicleNo = normaliseVehicleNo(b.vehicleNo);
    const ve = vehicleNoError(vehicleNo); if (ve) throw bad(ve);
    const t = e.invoice.tenant;
    const adapter = await getAdapter(tid(req), 'ewaybill').catch((e) => { throw asHttp(e); });
    try {
      const r = await adapter.updatePartB({ ewbNo: e.ewbNo, vehicleNo, fromPlace: b.fromPlace ?? t.city ?? t.name, fromState: t.stateCode, reasonCode: b.reasonCode, reasonRemark: b.remark, transMode: e.transMode as '1' });
      const u = await prisma.ewayBill.update({ where: { id: e.id }, data: { vehicleNo, validUpto: r.validUpto ?? e.validUpto } });
      await audit(req, 'EWAYBILL_VEHICLE', 'EwayBill', e.id, { ewbNo: e.ewbNo, from: e.vehicleNo, to: vehicleNo, reasonCode: b.reasonCode, remark: b.remark });
      return u;
    } catch (err) { throw asHttp(err); }
  });

  app.post('/ewaybill/:id/cancel', billing, async (req) => {
    const b = z.object({ reasonCode: reasonCode, remark: z.string().min(3).max(50) }).parse(req.body);
    const e = await loadEwb(req);
    if (Date.now() - e.ewbDate.getTime() > DAY) throw bad('E-way bills can be cancelled only within 24 hours of generation');
    const adapter = await getAdapter(tid(req), 'ewaybill').catch((e) => { throw asHttp(e); });
    try {
      const r = await adapter.cancelEwb(e.ewbNo, b.reasonCode, b.remark);
      const u = await prisma.ewayBill.update({ where: { id: e.id }, data: { status: 'CANCELLED', cancelledAt: r.cancelledAt, cancelReason: `${b.reasonCode}: ${b.remark}` } });
      await audit(req, 'EWAYBILL_CANCEL', 'EwayBill', e.id, { ewbNo: e.ewbNo, reasonCode: b.reasonCode, remark: b.remark });
      return u;
    } catch (err) { throw asHttp(err); }
  });

  app.post('/ewaybill/:id/extend', billing, async (req) => {
    const b = z.object({ remainingDistanceKm: z.number().int().positive().max(4000), reasonCode: z.enum(['1', '2', '3', '4', '99']), remark: z.string().min(3).max(50), fromPlace: z.string().optional(), fromPin: z.string().optional() }).parse(req.body);
    const e = await loadEwb(req);
    const t = e.invoice.tenant;
    const fromPin = b.fromPin ?? t.pincode;
    const pe = pincodeError(fromPin, 'Current location'); if (pe) throw bad(pe);
    const adapter = await getAdapter(tid(req), 'ewaybill').catch((e) => { throw asHttp(e); });
    try {
      const r = await adapter.extendValidity({ ewbNo: e.ewbNo, vehicleNo: e.vehicleNo ?? '', fromPlace: b.fromPlace ?? t.city ?? t.name, fromState: t.stateCode, fromPin: Number(fromPin), remainingDistanceKm: b.remainingDistanceKm, reasonCode: b.reasonCode, reasonRemark: b.remark });
      const u = await prisma.ewayBill.update({ where: { id: e.id }, data: { validUpto: r.validUpto } });
      await audit(req, 'EWAYBILL_EXTEND', 'EwayBill', e.id, { ewbNo: e.ewbNo, validUpto: r.validUpto, remark: b.remark });
      return u;
    } catch (err) { throw asHttp(err); }
  });
}
