import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { computeLine, sumBreakups } from '@onrmc/shared';
import { prisma, num, type Tx } from '../lib/prisma.js';
import { requireRole, tid } from '../lib/auth.js';
import { nextNumber } from '../lib/numbering.js';
import { accountId, post } from '../lib/ledger.js';
import { audit } from '../lib/audit.js';
import { bad, HttpError, notFound } from '../lib/errors.js';
import {
  buildIrpPayloadFromDoc, EinvoiceValidationError, getAdapter, getSettings, GspError, irpDate, noteDoc, noteForIrp, notRequiredReason,
} from '../lib/einvoice/index.js';

/**
 * GST credit / debit notes (s.34 CGST Act) against one issued invoice.
 *  - Same place of supply and tax type as the original; GST rate per line copied from the original line.
 *  - Credit notes never exceed what is left of the original (line taxable + debit notes − earlier credit notes).
 *  - Quantity credit notes (returned / short supply) are capped at the billed challan quantity still un-returned.
 *  - Debit notes are rate differences only: they can never add concrete quantity beyond what was delivered.
 *  - Ledger: CN Dr Sales returns & discounts + output GST, Cr customer; DN Dr customer, Cr sales + output GST.
 *  - Credit is applied to the invoice balance first; anything left is customer credit (seen in the ledger).
 */
const r2 = (n: number) => Math.round(n * 100) / 100;
const idParam = (req: { params: unknown }) => (req.params as { id: string }).id;
const DAY = 24 * 3600e3;

export const CREDIT_REASONS = ['RATE_DIFFERENCE', 'QUANTITY_RETURNED', 'SHORT_SUPPLY', 'POST_SUPPLY_DISCOUNT', 'IRN_CANCELLED_AFTER_24H'] as const;
export const DEBIT_REASONS = ['RATE_DIFFERENCE'] as const;
const QTY_REASONS = ['QUANTITY_RETURNED', 'SHORT_SUPPLY'];

/** What has already been credited / debited / returned per original invoice line (issued notes only). */
async function lineHistory(tx: Tx, invoiceId: string) {
  const lines = await tx.noteLine.findMany({ where: { note: { invoiceId, status: 'ISSUED' } }, include: { note: { select: { type: true, quantityBased: true } } } });
  const h = new Map<string, { credited: number; debited: number; returnedQty: number }>();
  for (const l of lines) {
    const x = h.get(l.invoiceLineId) ?? { credited: 0, debited: 0, returnedQty: 0 };
    if (l.note.type === 'CREDIT') x.credited += num(l.taxable); else x.debited += num(l.taxable);
    if (l.note.type === 'CREDIT' && l.note.quantityBased) x.returnedQty += num(l.quantity);
    h.set(l.invoiceLineId, x);
  }
  return h;
}

/** Invoice balance / status after notes or payments. */
export function invoiceStatus(inv: { status: string; total: unknown; noteAdj: unknown; paid: unknown }) {
  if (inv.status === 'CANCELLED') return 'CANCELLED' as const;
  const due = num(inv.total as never) + num(inv.noteAdj as never) - num(inv.paid as never);
  if (due <= 0.001) return 'PAID' as const;
  return num(inv.paid as never) > 0 ? ('PARTIALLY_PAID' as const) : ('ISSUED' as const);
}

function asHttp(e: unknown): Error {
  if (e instanceof EinvoiceValidationError) return new HttpError(422, `Cannot send to the portal: ${e.problems.join('; ')}`);
  if (e instanceof GspError) return new HttpError(e.code === 'NO_CREDENTIALS' || e.code === 'NOT_IMPLEMENTED' ? 400 : 502, `Portal error${e.code ? ` ${e.code}` : ''}: ${e.message}`);
  return e as Error;
}

export default async function (app: FastifyInstance) {
  const billing = { preHandler: requireRole('MANAGER', 'ACCOUNTANT') };

  /** Per invoice line: what can still be credited / returned — drives the create form. */
  app.get('/invoices/:id/note-limits', billing, async (req) => {
    const inv = await prisma.invoice.findFirst({ where: { id: idParam(req), tenantId: tid(req) }, include: { lines: { orderBy: { id: 'asc' } } } });
    if (!inv) throw notFound();
    const h = await lineHistory(prisma, inv.id);
    return inv.lines.map((l) => {
      const x = h.get(l.id) ?? { credited: 0, debited: 0, returnedQty: 0 };
      return { invoiceLineId: l.id, description: l.description, hsn: l.hsn, unit: l.unit, quantity: num(l.quantity), rate: num(l.rate), gstRate: num(l.gstRate), taxable: num(l.taxable),
        credited: r2(x.credited), debited: r2(x.debited), returnedQty: x.returnedQty,
        creditableTaxable: r2(num(l.taxable) + x.debited - x.credited), returnableQty: r2(num(l.quantity) - x.returnedQty) };
    });
  });

  app.get('/notes', billing, async (req) => {
    const { type, invoiceId, customerId, einvoiceStatus } = req.query as Record<string, string | undefined>;
    return prisma.creditDebitNote.findMany({
      where: { tenantId: tid(req), ...(type ? { type: type as never } : {}), ...(invoiceId ? { invoiceId } : {}), ...(customerId ? { customerId } : {}), ...(einvoiceStatus ? { einvoiceStatus: einvoiceStatus as never } : {}) },
      include: { customer: { select: { name: true } }, invoice: { select: { number: true, type: true } } }, orderBy: { issueDate: 'desc' }, take: 300,
    });
  });

  app.get('/notes/:id', { preHandler: requireRole('MANAGER', 'ACCOUNTANT', 'SALES') }, async (req) => {
    const n = await prisma.creditDebitNote.findFirst({ where: { id: idParam(req), tenantId: tid(req) }, include: { tenant: true, customer: true, invoice: { select: { id: true, number: true, issueDate: true, type: true, irn: true } }, lines: { orderBy: { id: 'asc' } } } });
    if (!n) throw notFound();
    return n;
  });

  app.post('/notes', billing, async (req) => {
    const b = z.object({
      invoiceId: z.string(), type: z.enum(['CREDIT', 'DEBIT']), reason: z.enum(CREDIT_REASONS), reasonText: z.string().max(200).optional(),
      lines: z.array(z.object({
        invoiceLineId: z.string(),
        quantity: z.number().positive().optional(), // returned qty, or qty the rate change applies to
        rate: z.number().positive().optional(),     // rate difference per unit
        amount: z.number().positive().optional(),   // lump-sum discount (taxable value)
      })).default([]),
    }).parse(req.body);
    if (b.type === 'DEBIT' && !(DEBIT_REASONS as readonly string[]).includes(b.reason)) throw bad('Debit notes are for rate differences only — they cannot add quantity beyond what was delivered.');
    const t = tid(req);

    const note = await prisma.$transaction(async (tx) => {
      const inv = await tx.invoice.findFirst({ where: { id: b.invoiceId, tenantId: t }, include: { lines: { orderBy: { id: 'asc' } }, customer: true } });
      if (!inv) throw notFound('Invoice not found');
      if (inv.status === 'CANCELLED' || inv.status === 'DRAFT') throw bad('Notes can only be issued against an issued invoice');
      const h = await lineHistory(tx, inv.id);
      const applyGst = inv.type === 'TAX_INVOICE';

      let wanted = b.lines;
      if (b.reason === 'IRN_CANCELLED_AFTER_24H') {
        if (b.type !== 'CREDIT') throw bad('Only a credit note can reverse an invoice');
        if (inv.einvoiceStatus !== 'GENERATED' || !inv.ackDate) throw bad('This reason is for invoices with an active IRN');
        if (Date.now() - inv.ackDate.getTime() <= DAY) throw bad('The IRN is less than 24 hours old — cancel the IRN and the invoice instead');
        if (h.size) throw bad('This invoice already has credit/debit notes; reverse the remaining value line by line instead');
        wanted = inv.lines.map((l) => ({ invoiceLineId: l.id, quantity: num(l.quantity), rate: undefined, amount: undefined }));
      }
      if (!wanted.length) throw bad('Add at least one line');
      if (new Set(wanted.map((w) => w.invoiceLineId)).size !== wanted.length) throw bad('Each invoice line can appear once');

      const quantityBased = QTY_REASONS.includes(b.reason) || b.reason === 'IRN_CANCELLED_AFTER_24H';
      const lines = wanted.map((w) => {
        const l = inv.lines.find((x) => x.id === w.invoiceLineId);
        if (!l) throw bad('Line does not belong to this invoice');
        const x = h.get(l.id) ?? { credited: 0, debited: 0, returnedQty: 0 };
        const lineQty = num(l.quantity), returnable = r2(lineQty - x.returnedQty);
        let quantity: number | null, rate: number;
        if (quantityBased) {
          quantity = w.quantity ?? 0; rate = num(l.rate);
          if (quantity <= 0) throw bad(`${l.description}: enter the quantity`);
          if (quantity > returnable + 1e-9) throw bad(`${l.description}: only ${returnable} ${l.unit} can still be credited (billed ${lineQty}, already credited ${x.returnedQty})`);
        } else if (b.reason === 'RATE_DIFFERENCE') {
          quantity = w.quantity ?? returnable; rate = w.rate ?? 0;
          if (rate <= 0) throw bad(`${l.description}: enter the rate difference per ${l.unit}`);
          if (quantity <= 0 || quantity > returnable + 1e-9) throw bad(`${l.description}: the rate change can apply to at most ${returnable} ${l.unit} (the billed quantity not returned)`);
        } else { // POST_SUPPLY_DISCOUNT — value only
          quantity = null; rate = w.amount ?? 0;
          if (rate <= 0) throw bad(`${l.description}: enter the discount amount`);
        }
        const gstRate = num(l.gstRate);
        const tb = computeLine({ quantity: quantity ?? 1, rate, gstRate }, inv.interState, applyGst);
        if (b.type === 'CREDIT') {
          const left = r2(num(l.taxable) + x.debited - x.credited);
          if (tb.taxable > left + 0.001) throw bad(`${l.description}: credit of ${tb.taxable} exceeds the remaining value ${left} of this line`);
        }
        return { invoiceLineId: l.id, description: l.description, hsn: l.hsn, quantity, unit: l.unit, rate, gstRate: applyGst ? gstRate : 0, tb };
      });
      const tot = sumBreakups(lines.map((l) => l.tb));
      const total = Math.round(tot.total);
      const roundOff = r2(total - tot.total);
      if (b.type === 'CREDIT') {
        const credited = await tx.creditDebitNote.aggregate({ where: { invoiceId: inv.id, status: 'ISSUED', type: 'CREDIT' }, _sum: { total: true } });
        const debited = await tx.creditDebitNote.aggregate({ where: { invoiceId: inv.id, status: 'ISSUED', type: 'DEBIT' }, _sum: { total: true } });
        const remaining = num(inv.total) + num(debited._sum.total) - num(credited._sum.total);
        if (total > remaining + 0.001) throw bad(`Credit of ${total} exceeds the remaining value of ${inv.number} (${r2(remaining)})`);
      }

      const settings = await getSettings(t, tx);
      const einvoiceStatus = settings?.einvoiceEnabled && !notRequiredReason({ type: inv.type, status: 'ISSUED', customer: inv.customer }) ? 'PENDING' : 'NOT_REQUIRED';
      const due = num(inv.total) + num(inv.noteAdj) - num(inv.paid);
      const applied = b.type === 'CREDIT' ? r2(Math.min(total, Math.max(0, due))) : 0;

      const n = await tx.creditDebitNote.create({ data: {
        tenantId: t, type: b.type, number: await nextNumber(tx, t, b.type === 'CREDIT' ? 'CN' : 'DN'), invoiceId: inv.id, customerId: inv.customerId,
        reason: b.reason, reasonText: b.reasonText, quantityBased: b.type === 'CREDIT' && quantityBased,
        placeOfSupply: inv.placeOfSupply, interState: inv.interState,
        taxable: tot.taxable, cgst: tot.cgst, sgst: tot.sgst, igst: tot.igst, roundOff, total, applied, einvoiceStatus, createdById: req.user.sub,
        lines: { create: lines.map(({ tb, ...l }) => ({ ...l, taxable: tb.taxable, tax: r2(tb.cgst + tb.sgst + tb.igst), total: tb.total })) },
      } });

      const customerAcc = inv.customer.accountId ?? (await accountId(tx, t, '1300'));
      const concrete = r2(lines.filter((l) => l.hsn.startsWith('3824')).reduce((s, l) => s + l.tb.taxable, 0));
      const gst = [
        { accountId: await accountId(tx, t, '2200'), amt: tot.cgst }, { accountId: await accountId(tx, t, '2210'), amt: tot.sgst }, { accountId: await accountId(tx, t, '2220'), amt: tot.igst },
      ];
      if (b.type === 'CREDIT') {
        await post(tx, t, `Credit note ${n.number} against ${inv.number}`, 'CREDIT_NOTE', n.id, [
          { accountId: await accountId(tx, t, '4900'), debit: tot.taxable },
          ...gst.map((g) => ({ accountId: g.accountId, debit: g.amt })),
          { accountId: await accountId(tx, t, '4100'), debit: roundOff },
          { accountId: customerAcc, credit: total },
        ]);
      } else {
        await post(tx, t, `Debit note ${n.number} against ${inv.number}`, 'DEBIT_NOTE', n.id, [
          { accountId: customerAcc, debit: total },
          { accountId: await accountId(tx, t, '4000'), credit: concrete },
          { accountId: await accountId(tx, t, '4100'), credit: r2(tot.taxable - concrete) },
          ...gst.map((g) => ({ accountId: g.accountId, credit: g.amt })),
          { accountId: await accountId(tx, t, '4100'), credit: roundOff },
        ]);
      }
      const noteAdj = r2(num(inv.noteAdj) + (b.type === 'CREDIT' ? -applied : total));
      await tx.invoice.update({ where: { id: inv.id }, data: { noteAdj, status: invoiceStatus({ ...inv, noteAdj }) } });
      return n;
    });
    await audit(req, 'ISSUE', b.type === 'CREDIT' ? 'CreditNote' : 'DebitNote', note.id, { number: note.number, reason: b.reason, total: num(note.total), applied: num(note.applied) });
    return note;
  });

  app.post('/notes/:id/cancel', billing, async (req) => {
    const { reason } = z.object({ reason: z.string().min(5) }).parse(req.body);
    const t = tid(req);
    await prisma.$transaction(async (tx) => {
      const n = await tx.creditDebitNote.findFirst({ where: { id: idParam(req), tenantId: t }, include: { invoice: true } });
      if (!n) throw notFound();
      if (n.status === 'CANCELLED') throw bad('Already cancelled');
      if (n.einvoiceStatus === 'GENERATED') throw bad('This note has an active IRN. Cancel the IRN first (within 24 hours).');
      const inv = n.invoice;
      const noteAdj = r2(num(inv.noteAdj) + (n.type === 'CREDIT' ? num(n.applied) : -num(n.total)));
      if (num(inv.total) + noteAdj - num(inv.paid) < -0.001) throw bad('Payments already cover this debit note — remove the allocation first.');
      const j = await tx.journal.findFirst({ where: { tenantId: t, sourceId: n.id, sourceType: n.type === 'CREDIT' ? 'CREDIT_NOTE' : 'DEBIT_NOTE' }, include: { entries: true } });
      if (j) await post(tx, t, `Cancel ${n.number}: ${reason}`, n.type === 'CREDIT' ? 'CREDIT_NOTE_CANCEL' : 'DEBIT_NOTE_CANCEL', n.id, j.entries.map((e) => ({ accountId: e.accountId, debit: num(e.credit), credit: num(e.debit) })));
      await tx.creditDebitNote.update({ where: { id: n.id }, data: { status: 'CANCELLED', cancelReason: reason } });
      await tx.invoice.update({ where: { id: inv.id }, data: { noteAdj, status: invoiceStatus({ ...inv, noteAdj }) } });
    });
    await audit(req, 'CANCEL', 'CreditDebitNote', idParam(req), { reason });
    return { ok: true };
  });

  // ───── E-invoice for notes (doc type CRN / DBN, preceding invoice in RefDtls) ─────
  async function loadNote(req: FastifyRequest) {
    const n = await prisma.creditDebitNote.findFirst({ where: { id: idParam(req), tenantId: tid(req) }, ...noteForIrp });
    if (!n) throw notFound('Note not found');
    return n;
  }

  app.get('/notes/:id/einvoice/preview', billing, async (req) => {
    try { return { ok: true, payload: buildIrpPayloadFromDoc(noteDoc(await loadNote(req))) }; } catch (e) {
      if (e instanceof EinvoiceValidationError) return { ok: false, problems: e.problems };
      throw e;
    }
  });

  app.post('/notes/:id/einvoice', billing, async (req) => {
    const n = await loadNote(req);
    if (n.status === 'CANCELLED') throw bad('Note is cancelled');
    if (n.einvoiceStatus === 'NOT_REQUIRED') throw bad('This note does not need an e-invoice');
    if (n.einvoiceStatus === 'GENERATED') throw bad(`IRN already generated (${n.irn})`);
    if (n.einvoiceStatus === 'CANCELLED') throw bad('The IRN for this note was cancelled; the number cannot be registered again. Cancel the note and issue a new one.');
    const adapter = await getAdapter(tid(req), 'einvoice').catch((e) => { throw asHttp(e); });
    const doc = noteDoc(n);
    try {
      const payload = buildIrpPayloadFromDoc(doc);
      let r;
      try { r = await adapter.generateIrn(payload); } catch (e) {
        if (e instanceof GspError && e.code === '2150') r = await adapter.getIrnByDocNo(doc.typ, n.number, irpDate(n.issueDate));
        if (!r) throw e;
      }
      await prisma.creditDebitNote.update({ where: { id: n.id }, data: { einvoiceStatus: 'GENERATED', irn: r.irn, ackNo: r.ackNo, ackDate: r.ackDate, signedQr: r.signedQr, signedInvoice: r.signedInvoice, einvoiceError: null } });
      await audit(req, 'EINVOICE_GENERATE', 'CreditDebitNote', n.id, { provider: adapter.name, docType: doc.typ, irn: r.irn, ackNo: r.ackNo, total: payload.ValDtls.TotInvVal });
      return { ok: true, irn: r.irn, ackNo: r.ackNo, ackDate: r.ackDate };
    } catch (e) {
      const err = asHttp(e);
      await prisma.creditDebitNote.update({ where: { id: n.id }, data: { einvoiceStatus: 'FAILED', einvoiceError: err.message.slice(0, 1000) } });
      await audit(req, 'EINVOICE_FAILED', 'CreditDebitNote', n.id, { provider: adapter.name, error: err.message });
      throw err;
    }
  });

  app.post('/notes/:id/einvoice/cancel', billing, async (req) => {
    const b = z.object({ reasonCode: z.enum(['1', '2', '3', '4']), remark: z.string().min(3).max(100) }).parse(req.body);
    const n = await loadNote(req);
    if (n.einvoiceStatus !== 'GENERATED' || !n.irn) throw bad('This note has no active IRN');
    if (n.ackDate && Date.now() - n.ackDate.getTime() > DAY) throw bad('IRNs can be cancelled only within 24 hours.');
    const adapter = await getAdapter(tid(req), 'einvoice').catch((e) => { throw asHttp(e); });
    try {
      const r = await adapter.cancelIrn(n.irn, b.reasonCode, b.remark);
      await prisma.creditDebitNote.update({ where: { id: n.id }, data: { einvoiceStatus: 'CANCELLED', irnCancelledAt: r.cancelledAt, irnCancelReason: `${b.reasonCode}: ${b.remark}` } });
      await audit(req, 'EINVOICE_CANCEL', 'CreditDebitNote', n.id, { irn: n.irn, reasonCode: b.reasonCode, remark: b.remark });
      return { ok: true };
    } catch (e) { throw asHttp(e); }
  });
}
