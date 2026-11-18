import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { computeLine, sumBreakups, RMC_HSN } from '@onrmc/shared';
import { prisma, num } from '../lib/prisma.js';
import { requireRole, tid } from '../lib/auth.js';
import { nextNumber } from '../lib/numbering.js';
import { accountId, post } from '../lib/ledger.js';
import { audit } from '../lib/audit.js';
import { bad, notFound } from '../lib/errors.js';
import { getSettings, notRequiredReason } from '../lib/einvoice/index.js';
import { invoiceStatus } from './notes.js';

const idParam = (req: { params: unknown }) => (req.params as { id: string }).id;

/**
 * Billing rules (enforced server-side):
 *  - Concrete lines are generated only from DELIVERED challans of this customer; qty = challan qty.
 *  - A challan can be billed once.
 *  - Extra charge lines (pumping, waiting, transport) are services and may not use the RMC HSN.
 *  - All totals are recomputed here; client-sent totals are ignored.
 *  - Issued invoices are never edited; cancel (with reason) reverses the ledger.
 */
export default async function (app: FastifyInstance) {
  app.get('/invoices', { preHandler: requireRole('MANAGER', 'ACCOUNTANT', 'SALES') }, async (req) => {
    const { status, customerId, from, to, einvoiceStatus } = req.query as Record<string, string | undefined>;
    return prisma.invoice.findMany({
      where: {
        tenantId: tid(req), ...(status ? { status: status as never } : {}), ...(customerId ? { customerId } : {}),
        ...(einvoiceStatus ? { einvoiceStatus: einvoiceStatus as never } : {}),
        ...(from || to ? { issueDate: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}),
      },
      include: { customer: { select: { name: true, gstin: true } }, ewayBills: { where: { status: 'ACTIVE' }, select: { ewbNo: true, validUpto: true } } }, orderBy: { issueDate: 'desc' }, take: 300,
    });
  });

  app.get('/invoices/:id', { preHandler: requireRole('MANAGER', 'ACCOUNTANT', 'SALES') }, async (req) => {
    const inv = await prisma.invoice.findFirst({
      where: { id: idParam(req), tenantId: tid(req) },
      include: { customer: true, tenant: true, lines: { include: { challan: { select: { number: true, deliveredAt: true, vehicle: { select: { number: true } } } } } }, allocations: { include: { payment: true } }, ewayBills: { orderBy: { createdAt: 'desc' } }, creditDebitNotes: { orderBy: { issueDate: 'asc' }, select: { id: true, number: true, type: true, reason: true, total: true, applied: true, status: true, issueDate: true, einvoiceStatus: true } } },
    });
    if (!inv) throw notFound();
    return inv;
  });

  app.post('/invoices', { preHandler: requireRole('MANAGER', 'ACCOUNTANT') }, async (req) => {
    const b = z.object({
      type: z.enum(['TAX_INVOICE', 'BILL_OF_SUPPLY']),
      customerId: z.string(),
      challanIds: z.array(z.string()).min(1),
      extras: z.array(z.object({
        description: z.string().min(2), hsn: z.string().min(4), quantity: z.number().positive(), unit: z.string().default('NOS'),
        rate: z.number().nonnegative(), gstRate: z.number().min(0).max(28),
      })).default([]),
      notes: z.string().optional(),
    }).parse(req.body);
    const t = tid(req);

    const inv = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: t } });
      const customer = await tx.customer.findFirst({ where: { id: b.customerId, tenantId: t } });
      if (!customer) throw notFound('Customer not found');
      if (b.type === 'TAX_INVOICE' && !tenant.gstin) throw bad('Add your company GSTIN before issuing tax invoices');
      if (b.extras.some((e) => e.hsn.startsWith('3824'))) throw bad('Concrete can only be billed from delivery challans');

      const challans = await tx.challan.findMany({
        where: { id: { in: b.challanIds }, tenantId: t, status: { in: ['DELIVERED', 'RETURNED'] }, invoiceLine: null, order: { customerId: customer.id } },
        include: { order: { include: { mixDesign: true, site: true } } },
      });
      if (challans.length !== b.challanIds.length) throw bad('Some challans are not delivered, belong to another customer, or are already billed');

      const placeOfSupply = challans[0].order.site.stateCode;
      if (challans.some((c) => c.order.site.stateCode !== placeOfSupply)) throw bad('Challans for sites in different states must be billed on separate invoices');
      const interState = placeOfSupply !== tenant.stateCode;
      const applyGst = b.type === 'TAX_INVOICE';

      const lines = [
        ...challans.map((c) => {
          const gstRate = num(c.order.mixDesign.gstRate);
          const qty = num(c.quantityM3), rate = num(c.order.rate);
          const tb = computeLine({ quantity: qty, rate, gstRate }, interState, applyGst);
          return { challanId: c.id, description: `Ready Mix Concrete ${c.order.mixDesign.grade} — DC ${c.number}`, hsn: c.order.mixDesign.hsn || RMC_HSN, quantity: qty, unit: 'M3', rate, gstRate: applyGst ? gstRate : 0, tb };
        }),
        ...b.extras.map((e) => {
          const tb = computeLine({ quantity: e.quantity, rate: e.rate, gstRate: e.gstRate }, interState, applyGst);
          return { challanId: null, description: e.description, hsn: e.hsn, quantity: e.quantity, unit: e.unit, rate: e.rate, gstRate: applyGst ? e.gstRate : 0, tb };
        }),
      ];
      const tot = sumBreakups(lines.map((l) => l.tb));
      const rounded = Math.round(tot.total);
      const roundOff = Math.round((rounded - tot.total) * 100) / 100;

      const prefix = b.type === 'TAX_INVOICE' ? 'INV' : 'BOS';
      const einv = await getSettings(t, tx);
      const einvoiceStatus = einv?.einvoiceEnabled && !notRequiredReason({ type: b.type, status: 'ISSUED', customer }) ? 'PENDING' : 'NOT_REQUIRED';
      const invoice = await tx.invoice.create({
        data: {
          tenantId: t, type: b.type, number: await nextNumber(tx, t, prefix), customerId: customer.id,
          placeOfSupply, interState, status: 'ISSUED', einvoiceStatus, dueDate: new Date(Date.now() + customer.creditDays * 864e5),
          taxable: tot.taxable, cgst: tot.cgst, sgst: tot.sgst, igst: tot.igst, roundOff, total: rounded,
          notes: b.notes, createdById: req.user.sub,
          lines: { create: lines.map(({ tb, ...l }) => ({ ...l, taxable: tb.taxable, tax: tb.cgst + tb.sgst + tb.igst, total: tb.total })) },
        },
      });

      const concreteTaxable = lines.filter((l) => l.challanId).reduce((s, l) => s + l.tb.taxable, 0);
      await post(tx, t, `Sales ${invoice.number}`, 'INVOICE', invoice.id, [
        { accountId: customer.accountId ?? (await accountId(tx, t, '1300')), debit: rounded },
        { accountId: await accountId(tx, t, '4000'), credit: concreteTaxable },
        { accountId: await accountId(tx, t, '4100'), credit: Math.round((tot.taxable - concreteTaxable) * 100) / 100 },
        { accountId: await accountId(tx, t, '2200'), credit: tot.cgst },
        { accountId: await accountId(tx, t, '2210'), credit: tot.sgst },
        { accountId: await accountId(tx, t, '2220'), credit: tot.igst },
        ...(roundOff ? [{ accountId: await accountId(tx, t, '4100'), credit: roundOff }] : []),
      ]);

      const orderIds = [...new Set(challans.map((c) => c.orderId))];
      for (const oid of orderIds) {
        const o = await tx.order.findUniqueOrThrow({ where: { id: oid }, include: { challans: true } });
        const delivered = o.challans.filter((c) => ['DELIVERED', 'RETURNED'].includes(c.status)).reduce((s, c) => s + num(c.quantityM3), 0);
        if (delivered >= num(o.quantityM3)) await tx.order.update({ where: { id: oid }, data: { status: 'COMPLETED' } });
      }
      return invoice;
    });
    await audit(req, 'ISSUE', 'Invoice', inv.id, { number: inv.number, total: num(inv.total) });
    return inv;
  });

  app.post('/invoices/:id/cancel', { preHandler: requireRole('MANAGER', 'ACCOUNTANT') }, async (req) => {
    const { reason } = z.object({ reason: z.string().min(5) }).parse(req.body);
    const t = tid(req);
    await prisma.$transaction(async (tx) => {
      const inv = await tx.invoice.findFirst({ where: { id: idParam(req), tenantId: t }, include: { lines: true } });
      if (!inv) throw notFound();
      if (inv.status === 'CANCELLED') throw bad('Already cancelled');
      if (num(inv.paid) > 0) throw bad('Invoice has payments. Remove allocations or issue a credit note.');
      if (inv.einvoiceStatus === 'GENERATED') {
        const old = inv.ackDate && Date.now() - inv.ackDate.getTime() > 24 * 3600e3;
        throw bad(old
          ? 'This invoice has an IRN older than 24 hours, which the IRP no longer allows to be cancelled. Issue a credit note instead.'
          : 'This invoice has an active IRN. Cancel the IRN (e-invoice) first, then cancel the invoice.');
      }
      if (await tx.ewayBill.count({ where: { invoiceId: inv.id, status: 'ACTIVE' } })) throw bad('Cancel the active e-way bill first.');
      if (await tx.creditDebitNote.count({ where: { invoiceId: inv.id, status: 'ISSUED' } })) throw bad('This invoice has credit/debit notes. Cancel them first.');
      const j = await tx.journal.findFirst({ where: { tenantId: t, sourceType: 'INVOICE', sourceId: inv.id }, include: { entries: true } });
      if (j) await post(tx, t, `Cancel ${inv.number}: ${reason}`, 'INVOICE_CANCEL', inv.id, j.entries.map((e) => ({ accountId: e.accountId, debit: num(e.credit), credit: num(e.debit) })));
      // free the challans so they can be billed again correctly
      await tx.invoiceLine.updateMany({ where: { invoiceId: inv.id }, data: { challanId: null } });
      await tx.invoice.update({ where: { id: inv.id }, data: { status: 'CANCELLED', cancelReason: reason } });
    });
    await audit(req, 'CANCEL', 'Invoice', idParam(req), { reason });
    return { ok: true };
  });

  // ───── Payments (receipts from customers) ─────
  app.get('/payments', { preHandler: requireRole('MANAGER', 'ACCOUNTANT') }, async (req) =>
    prisma.payment.findMany({ where: { tenantId: tid(req) }, include: { customer: { select: { name: true } }, allocations: { include: { invoice: { select: { number: true } } } } }, orderBy: { receivedAt: 'desc' }, take: 300 }));

  app.post('/payments', { preHandler: requireRole('MANAGER', 'ACCOUNTANT') }, async (req) => {
    const b = z.object({
      customerId: z.string(), amount: z.number().positive(), mode: z.enum(['CASH', 'BANK_TRANSFER', 'UPI', 'CHEQUE', 'CARD']),
      reference: z.string().optional(), receivedAt: z.coerce.date().optional(), notes: z.string().optional(),
      /** Optional manual allocation; otherwise oldest invoices are settled first (FIFO). */
      allocations: z.array(z.object({ invoiceId: z.string(), amount: z.number().positive() })).optional(),
    }).parse(req.body);
    const t = tid(req);
    const p = await prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findFirst({ where: { id: b.customerId, tenantId: t } });
      if (!customer) throw notFound('Customer not found');
      const payment = await tx.payment.create({ data: { tenantId: t, number: await nextNumber(tx, t, 'RCPT'), customerId: customer.id, amount: b.amount, mode: b.mode, reference: b.reference, receivedAt: b.receivedAt, notes: b.notes } });

      let allocs = b.allocations;
      if (!allocs) {
        allocs = [];
        let left = b.amount;
        const open = await tx.invoice.findMany({ where: { tenantId: t, customerId: customer.id, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } }, orderBy: { issueDate: 'asc' } });
        for (const inv of open) {
          if (left <= 0) break;
          const due = num(inv.total) + num(inv.noteAdj) - num(inv.paid);
          const a = Math.min(due, left);
          if (a > 0) { allocs.push({ invoiceId: inv.id, amount: a }); left -= a; }
        }
      }
      if (allocs.reduce((s, a) => s + a.amount, 0) > b.amount + 0.001) throw bad('Allocations exceed payment amount');
      for (const a of allocs) {
        const inv = await tx.invoice.findFirst({ where: { id: a.invoiceId, tenantId: t, customerId: customer.id } });
        if (!inv || inv.status === 'CANCELLED') throw bad('Invalid invoice in allocation');
        const paid = num(inv.paid) + a.amount;
        // balance includes debit notes and credit notes applied to this invoice
        if (paid > num(inv.total) + num(inv.noteAdj) + 0.001) throw bad(`Allocation exceeds balance of ${inv.number}`);
        await tx.paymentAllocation.create({ data: { paymentId: payment.id, invoiceId: inv.id, amount: a.amount } });
        await tx.invoice.update({ where: { id: inv.id }, data: { paid, status: invoiceStatus({ ...inv, paid }) } });
      }
      await post(tx, t, `Receipt ${payment.number} from ${customer.name}`, 'PAYMENT', payment.id, [
        { accountId: await accountId(tx, t, b.mode === 'CASH' ? '1100' : '1200'), debit: b.amount },
        { accountId: customer.accountId ?? (await accountId(tx, t, '1300')), credit: b.amount },
      ], b.receivedAt);
      return payment;
    });
    await audit(req, 'CREATE', 'Payment', p.id, { amount: b.amount });
    return p;
  });
}
