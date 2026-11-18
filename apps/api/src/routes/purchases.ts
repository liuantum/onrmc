import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { computeLine, sumBreakups } from '@onrmc/shared';
import { prisma, num, type Tx } from '../lib/prisma.js';
import { requireRole, tid } from '../lib/auth.js';
import { nextNumber } from '../lib/numbering.js';
import { accountId, post, type Leg } from '../lib/ledger.js';
import { audit } from '../lib/audit.js';
import { bad, notFound } from '../lib/errors.js';
import { gstinError, pincodeError, stateError } from '../lib/einvoice/validate.js';

/**
 * Payables.
 *  GRN (operations.ts):  Dr Inventory @ GRN rate            / Cr Goods received, not billed (2150)
 *  Material bill:        Dr 2150 (GRN value) ± Inventory (rate variance, revalues moving average)
 *                        + Supplier claims 1530 (billed > received) + Input GST 1500 + TCS 1520
 *                        / Cr Supplier (payable) + TDS payable 2300 + RCM GST payable 2230
 *  Expense bill:         Dr expense account + Input GST     / Cr Supplier (+ TDS / RCM as above)
 *  Supplier payment:     Dr Supplier / Cr Cash or Bank, allocated to the oldest bills first
 *  Supplier debit note:  Dr Supplier / Cr 1530 (short supply) or Inventory / expense (rate, other) + Cr Input GST
 */
const r2 = (n: number) => Math.round(n * 100) / 100;
const idParam = (req: { params: unknown }) => (req.params as { id: string }).id;
const roles = { preHandler: requireRole('MANAGER', 'ACCOUNTANT') };

export function billStatus(b: { status: string; payable: unknown; paid: unknown; debitNoted: unknown }) {
  if (b.status === 'CANCELLED') return 'CANCELLED' as const;
  const due = num(b.payable as never) - num(b.paid as never) - num(b.debitNoted as never);
  if (due <= 0.001) return 'PAID' as const;
  return num(b.paid as never) > 0 || num(b.debitNoted as never) > 0 ? ('PARTIALLY_PAID' as const) : ('OPEN' as const);
}
const billDue = (b: { payable: unknown; paid: unknown; debitNoted: unknown }) => r2(num(b.payable as never) - num(b.paid as never) - num(b.debitNoted as never));

/**
 * Moves a value difference on a material into the books and the moving average: the share still in stock
 * revalues Inventory (avgCost += part / stock qty); the share already consumed goes to Cost of materials consumed.
 */
async function revalue(tx: Tx, t: string, materialId: string, amount: number, receivedQty: number): Promise<Leg[]> {
  if (!amount) return [];
  const mat = await tx.material.findFirstOrThrow({ where: { id: materialId, tenantId: t } });
  const stock = num((await tx.stock.aggregate({ where: { materialId }, _sum: { quantity: true } }))._sum.quantity);
  const share = stock > 0.0001 ? (receivedQty > 0 ? Math.min(1, stock / receivedQty) : 1) : 0;
  const inv = r2(amount * share), cogs = r2(amount - inv);
  if (inv) await tx.material.update({ where: { id: mat.id }, data: { avgCost: Math.max(0, num(mat.avgCost) + inv / stock) } });
  return [
    ...(inv ? [{ accountId: await accountId(tx, t, '1400'), debit: inv }] : []),
    ...(cogs ? [{ accountId: await accountId(tx, t, '5000'), debit: cogs }] : []),
  ];
}

const billBody = z.object({
  supplierId: z.string(), supplierBillNo: z.string().min(1).max(30), billDate: z.coerce.date(),
  kind: z.enum(['MATERIAL', 'EXPENSE']), receiptIds: z.array(z.string()).default([]),
  lines: z.array(z.object({
    materialId: z.string().optional(), expenseAccountId: z.string().optional(), description: z.string().optional(), hsn: z.string().optional(),
    quantity: z.number().positive(), unit: z.string().optional(), rate: z.number().nonnegative(), gstRate: z.number().min(0).max(28),
  })).min(1),
  rcm: z.boolean().optional(), tdsSection: z.string().optional(), tdsRate: z.number().min(0).max(30).default(0), tcsAmount: z.number().min(0).default(0),
  /** Total printed on the supplier's bill — must agree with our calculation to within ₹1 (round-off). */
  supplierTotal: z.number().positive().optional(), notes: z.string().optional(),
});

/** Computes a bill (matching, GST, TDS/TCS) without saving. Used by preview and create. */
async function computeBill(tx: Tx, t: string, b: z.infer<typeof billBody>) {
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: t } });
  const sup = await tx.supplier.findFirst({ where: { id: b.supplierId, tenantId: t } });
  if (!sup) throw notFound('Supplier not found');
  const interState = (sup.stateCode ?? tenant.stateCode) !== tenant.stateCode;
  const rcm = b.rcm ?? sup.rcmDefault;

  type GrnAgg = { qty: number; value: number };
  const grn = new Map<string, GrnAgg>();
  let receipts: { id: string; number: string }[] = [];
  if (b.kind === 'MATERIAL') {
    if (!b.receiptIds.length) throw bad('Pick the goods receipts this bill covers');
    const rs = await tx.materialReceipt.findMany({ where: { id: { in: b.receiptIds }, tenantId: t }, include: { lines: true } });
    if (rs.length !== b.receiptIds.length) throw bad('Goods receipt not found');
    for (const r of rs) {
      if (r.supplierId !== sup.id) throw bad(`${r.number} is from another supplier`);
      if (r.legacyPosted) throw bad(`${r.number} was posted to the supplier before bills existed`);
      if (r.billId) throw bad(`${r.number} is already billed`);
      for (const l of r.lines) {
        const g = grn.get(l.materialId) ?? { qty: 0, value: 0 };
        g.qty += num(l.quantity); g.value += num(l.quantity) * num(l.rate);
        grn.set(l.materialId, g);
      }
    }
    receipts = rs.map((r) => ({ id: r.id, number: r.number }));
    for (const g of grn.values()) g.value = r2(g.value);
    const billed = new Set(b.lines.map((l) => l.materialId));
    if (b.lines.some((l) => !l.materialId || l.expenseAccountId)) throw bad('Material bills have material lines only — use an expense bill for services and freight');
    if (billed.size !== b.lines.length) throw bad('Each material can appear once on the bill');
    for (const m of grn.keys()) if (!billed.has(m)) throw bad('Every material on the selected receipts must be on the bill');
    for (const m of billed) if (!grn.has(m!)) throw bad('A billed material is not on the selected receipts');
  } else if (b.lines.some((l) => !l.expenseAccountId || l.materialId) || b.receiptIds.length) {
    throw bad('Expense bills need an expense account on every line and no goods receipts');
  }

  const mats = await tx.material.findMany({ where: { tenantId: t, id: { in: b.lines.flatMap((l) => (l.materialId ? [l.materialId] : [])) } } });
  const accs = await tx.account.findMany({ where: { tenantId: t, id: { in: b.lines.flatMap((l) => (l.expenseAccountId ? [l.expenseAccountId] : [])) } } });
  const lines = b.lines.map((l) => {
    const tb = computeLine({ quantity: l.quantity, rate: l.rate, gstRate: l.gstRate }, interState, true);
    if (l.materialId) {
      const m = mats.find((x) => x.id === l.materialId);
      if (!m) throw bad('Material not found');
      const g = grn.get(m.id)!;
      const excess = Math.max(0, l.quantity - g.qty);
      const claimValue = excess > 1e-9 ? r2(excess * l.rate) : 0;
      const inventoryAdj = r2(tb.taxable - claimValue - g.value);
      const grnRate = g.qty ? g.value / g.qty : 0;
      return {
        materialId: m.id, expenseAccountId: null, description: l.description ?? m.name, hsn: l.hsn ?? null, quantity: l.quantity, unit: l.unit ?? m.unit,
        rate: l.rate, gstRate: l.gstRate, tb, grnQty: g.qty, grnValue: g.value, inventoryAdj, claimQty: excess, claimValue,
        variance: { qty: r2(l.quantity - g.qty), rate: Math.round((l.rate - grnRate) * 10000) / 10000, value: r2(tb.taxable - g.value) },
      };
    }
    const a = accs.find((x) => x.id === l.expenseAccountId);
    if (!a || !['EXPENSE', 'ASSET'].includes(a.type)) throw bad('Expense lines must use an expense (or asset) account');
    return {
      materialId: null, expenseAccountId: a.id, description: l.description ?? a.name, hsn: l.hsn ?? null, quantity: l.quantity, unit: l.unit ?? 'NOS',
      rate: l.rate, gstRate: l.gstRate, tb, grnQty: null, grnValue: null, inventoryAdj: 0, claimQty: 0, claimValue: 0, variance: null,
    };
  });
  const tot = sumBreakups(lines.map((l) => l.tb));
  const gst = r2(tot.cgst + tot.sgst + tot.igst);
  const computed = r2(tot.taxable + (rcm ? 0 : gst));
  let roundOff = r2(Math.round(computed) - computed);
  if (b.supplierTotal != null) {
    roundOff = r2(b.supplierTotal - computed);
    if (Math.abs(roundOff) > 1) throw bad(`Our total ${computed.toFixed(2)} differs from the supplier's bill total ${b.supplierTotal.toFixed(2)} by more than ₹1 — check quantities, rates and GST`);
  }
  const total = r2(computed + roundOff);
  const tdsAmount = b.tdsRate ? Math.round((tot.taxable * b.tdsRate) / 100) : 0;
  const payable = r2(total - tdsAmount + b.tcsAmount);
  return { sup, tenant, interState, rcm, lines, tot, gst, roundOff, total, tdsAmount, payable, receipts };
}

export default async function (app: FastifyInstance) {
  // ───── Suppliers ─────
  const supplierBody = z.object({
    name: z.string().min(1), gstin: z.string().optional().nullable(), stateCode: z.string().length(2).optional().nullable(),
    phone: z.string().optional().nullable(), email: z.string().optional().nullable(), address: z.string().optional().nullable(),
    city: z.string().optional().nullable(), pincode: z.string().optional().nullable(),
    paymentTermsDays: z.number().int().min(0).max(365).optional(), rcmDefault: z.boolean().optional(),
  });
  function checkSupplier(b: z.infer<typeof supplierBody>) {
    if (b.gstin) {
      b.gstin = b.gstin.trim().toUpperCase();
      const e = gstinError(b.gstin, 'Supplier'); if (e) throw bad(e);
      if (b.stateCode && b.stateCode !== b.gstin.slice(0, 2)) throw bad('State code does not match the GSTIN');
      b.stateCode = b.gstin.slice(0, 2);
    }
    if (b.stateCode) { const e = stateError(b.stateCode, 'Supplier'); if (e) throw bad(e); }
    if (b.pincode) { const e = pincodeError(b.pincode, 'Supplier'); if (e) throw bad(e); }
  }

  app.get('/suppliers', { preHandler: requireRole('MANAGER', 'STORE', 'ACCOUNTANT') }, async (req) => {
    const t = tid(req);
    const sups = await prisma.supplier.findMany({ where: { tenantId: t }, orderBy: { name: 'asc' } });
    const sums = await prisma.journalEntry.groupBy({ by: ['accountId'], where: { accountId: { in: sups.flatMap((s) => (s.accountId ? [s.accountId] : [])) } }, _sum: { debit: true, credit: true } });
    return sups.map((s) => {
      const x = sums.find((y) => y.accountId === s.accountId);
      return { ...s, balance: r2(num(x?._sum.credit) - num(x?._sum.debit)) }; // + = we owe them
    });
  });

  app.post('/suppliers', { preHandler: requireRole('MANAGER', 'STORE', 'ACCOUNTANT') }, async (req) => {
    const b = supplierBody.extend({ openingBalance: z.number().min(0).default(0) }).parse(req.body);
    checkSupplier(b);
    const t = tid(req);
    const s = await prisma.$transaction(async (tx) => {
      const n = await tx.account.count({ where: { tenantId: t, group: 'Sundry Creditors', system: false } });
      const acc = await tx.account.create({ data: { tenantId: t, code: `21${String(n + 1).padStart(4, '0')}`, name: b.name, type: 'LIABILITY', group: 'Sundry Creditors' } });
      const sup = await tx.supplier.create({ data: { ...b, tenantId: t, accountId: acc.id } });
      if (b.openingBalance > 0) {
        await post(tx, t, `Opening balance — ${b.name}`, 'OPENING_SUPPLIER', sup.id, [
          { accountId: await accountId(tx, t, '3000'), debit: b.openingBalance }, { accountId: acc.id, credit: b.openingBalance },
        ]);
      }
      return sup;
    });
    await audit(req, 'CREATE', 'Supplier', s.id, { name: s.name, gstin: s.gstin, openingBalance: b.openingBalance });
    return s;
  });

  app.put('/suppliers/:id', { preHandler: requireRole('MANAGER', 'ACCOUNTANT') }, async (req) => {
    const b = supplierBody.partial().parse(req.body);
    checkSupplier(b as z.infer<typeof supplierBody>);
    const r = await prisma.supplier.updateMany({ where: { id: idParam(req), tenantId: tid(req) }, data: b });
    if (!r.count) throw notFound();
    await audit(req, 'UPDATE', 'Supplier', idParam(req), b);
    return { ok: true };
  });

  // ───── Purchase bills ─────
  app.post('/purchase-bills/preview', roles, async (req) => {
    const c = await computeBill(prisma, tid(req), billBody.parse(req.body));
    return {
      interState: c.interState, rcm: c.rcm, taxable: c.tot.taxable, cgst: c.tot.cgst, sgst: c.tot.sgst, igst: c.tot.igst, roundOff: c.roundOff,
      total: c.total, tdsAmount: c.tdsAmount, payable: c.payable,
      lines: c.lines.map(({ tb, ...l }) => ({ ...l, taxable: tb.taxable, tax: r2(tb.cgst + tb.sgst + tb.igst), total: tb.total })),
    };
  });

  app.post('/purchase-bills', roles, async (req) => {
    const b = billBody.parse(req.body);
    const t = tid(req);
    const bill = await prisma.$transaction(async (tx) => {
      const c = await computeBill(tx, t, b);
      if (await tx.purchaseBill.findFirst({ where: { tenantId: t, supplierId: c.sup.id, supplierBillNo: b.supplierBillNo, status: { not: 'CANCELLED' } } }))
        throw bad(`Bill ${b.supplierBillNo} from ${c.sup.name} is already entered`);
      const created = await tx.purchaseBill.create({ data: {
        tenantId: t, number: await nextNumber(tx, t, 'PB', b.billDate), supplierId: c.sup.id, supplierBillNo: b.supplierBillNo, billDate: b.billDate,
        dueDate: new Date(b.billDate.getTime() + c.sup.paymentTermsDays * 864e5), kind: b.kind, interState: c.interState, rcm: c.rcm,
        taxable: c.tot.taxable, cgst: c.tot.cgst, sgst: c.tot.sgst, igst: c.tot.igst, roundOff: c.roundOff, total: c.total,
        tdsSection: b.tdsSection, tdsRate: b.tdsRate, tdsAmount: c.tdsAmount, tcsAmount: b.tcsAmount, payable: c.payable,
        notes: b.notes, createdById: req.user.sub,
        lines: { create: c.lines.map(({ tb, variance: _v, ...l }) => ({ ...l, taxable: tb.taxable, tax: r2(tb.cgst + tb.sgst + tb.igst), total: tb.total })) },
      } });
      if (c.receipts.length) await tx.materialReceipt.updateMany({ where: { id: { in: c.receipts.map((r) => r.id) } }, data: { billId: created.id } });

      const legs: Leg[] = [];
      for (const l of c.lines) {
        if (l.materialId) {
          legs.push({ accountId: await accountId(tx, t, '2150'), debit: l.grnValue! });
          legs.push(...(await revalue(tx, t, l.materialId, l.inventoryAdj, l.grnQty!)));
          if (l.claimValue) legs.push({ accountId: await accountId(tx, t, '1530'), debit: l.claimValue });
        } else legs.push({ accountId: l.expenseAccountId!, debit: l.tb.taxable });
      }
      legs.push({ accountId: await accountId(tx, t, '1500'), debit: c.gst });
      if (c.rcm) legs.push({ accountId: await accountId(tx, t, '2230'), credit: c.gst });
      if (b.tcsAmount) legs.push({ accountId: await accountId(tx, t, '1520'), debit: b.tcsAmount });
      if (c.tdsAmount) legs.push({ accountId: await accountId(tx, t, '2300'), credit: c.tdsAmount });
      if (c.roundOff) legs.push({ accountId: await accountId(tx, t, '5400'), debit: c.roundOff });
      legs.push({ accountId: c.sup.accountId ?? (await accountId(tx, t, '2100')), credit: c.payable });
      await post(tx, t, `Purchase bill ${created.number} (${c.sup.name} #${b.supplierBillNo})`, 'PURCHASE_BILL', created.id, legs, b.billDate);
      return created;
    });
    await audit(req, 'CREATE', 'PurchaseBill', bill.id, { number: bill.number, supplierBillNo: bill.supplierBillNo, total: num(bill.total), payable: num(bill.payable), rcm: bill.rcm });
    return bill;
  });

  app.get('/purchase-bills', roles, async (req) => {
    const { supplierId, status } = req.query as Record<string, string | undefined>;
    return prisma.purchaseBill.findMany({
      where: { tenantId: tid(req), ...(supplierId ? { supplierId } : {}), ...(status ? { status: status as never } : {}) },
      include: { supplier: { select: { name: true } } }, orderBy: { billDate: 'desc' }, take: 300,
    });
  });

  app.get('/purchase-bills/:id', roles, async (req) => {
    const bill = await prisma.purchaseBill.findFirst({
      where: { id: idParam(req), tenantId: tid(req) },
      include: {
        supplier: true, lines: { orderBy: { id: 'asc' }, include: { material: { select: { name: true, unit: true } }, debitNoteLines: { where: { note: { status: 'ISSUED' } }, include: { note: { select: { reason: true } } } } } },
        receipts: { select: { id: true, number: true, receivedAt: true, amount: true } },
        allocations: { include: { payment: { select: { number: true, paidAt: true, mode: true } } } },
        debitNotes: { orderBy: { issueDate: 'asc' } },
      },
    });
    if (!bill) throw notFound();
    const expenseAccounts = await prisma.account.findMany({ where: { id: { in: bill.lines.flatMap((l) => (l.expenseAccountId ? [l.expenseAccountId] : [])) } }, select: { id: true, name: true } });
    return { ...bill, due: billDue(bill), expenseAccounts };
  });

  app.post('/purchase-bills/:id/cancel', roles, async (req) => {
    const { reason } = z.object({ reason: z.string().min(5) }).parse(req.body);
    const t = tid(req);
    await prisma.$transaction(async (tx) => {
      const bill = await tx.purchaseBill.findFirst({ where: { id: idParam(req), tenantId: t }, include: { lines: true } });
      if (!bill) throw notFound();
      if (bill.status === 'CANCELLED') throw bad('Already cancelled');
      if (num(bill.paid) > 0) throw bad('This bill has payments allocated. Reverse them first.');
      if (await tx.supplierDebitNote.count({ where: { billId: bill.id, status: 'ISSUED' } })) throw bad('Cancel the debit notes on this bill first');
      const j = await tx.journal.findFirst({ where: { tenantId: t, sourceType: 'PURCHASE_BILL', sourceId: bill.id }, include: { entries: true } });
      if (j) {
        // undo the moving-average revaluation (the journal reversal below undoes the ledger side)
        for (const l of bill.lines.filter((x) => x.materialId && num(x.inventoryAdj))) await revalue(tx, t, l.materialId!, -num(l.inventoryAdj), num(l.grnQty));
        await post(tx, t, `Cancel ${bill.number}: ${reason}`, 'PURCHASE_BILL_CANCEL', bill.id, j.entries.map((e) => ({ accountId: e.accountId, debit: num(e.credit), credit: num(e.debit) })));
      }
      await tx.materialReceipt.updateMany({ where: { billId: bill.id }, data: { billId: null } });
      await tx.purchaseBill.update({ where: { id: bill.id }, data: { status: 'CANCELLED', cancelReason: reason } });
    });
    await audit(req, 'CANCEL', 'PurchaseBill', idParam(req), { reason });
    return { ok: true };
  });

  // ───── Supplier payments ─────
  app.get('/supplier-payments', roles, async (req) =>
    prisma.supplierPayment.findMany({ where: { tenantId: tid(req) }, include: { supplier: { select: { name: true } }, allocations: { include: { bill: { select: { number: true, supplierBillNo: true } } } } }, orderBy: { paidAt: 'desc' }, take: 300 }));

  app.post('/supplier-payments', roles, async (req) => {
    const b = z.object({
      supplierId: z.string(), amount: z.number().positive(), mode: z.enum(['CASH', 'BANK_TRANSFER', 'UPI', 'CHEQUE', 'CARD']),
      reference: z.string().optional(), paidAt: z.coerce.date().optional(), notes: z.string().optional(),
      allocations: z.array(z.object({ billId: z.string(), amount: z.number().positive() })).optional(),
    }).parse(req.body);
    const t = tid(req);
    const p = await prisma.$transaction(async (tx) => {
      const sup = await tx.supplier.findFirst({ where: { id: b.supplierId, tenantId: t } });
      if (!sup) throw notFound('Supplier not found');
      const payment = await tx.supplierPayment.create({ data: { tenantId: t, number: await nextNumber(tx, t, 'PV'), supplierId: sup.id, amount: b.amount, mode: b.mode, reference: b.reference, paidAt: b.paidAt, notes: b.notes } });
      let allocs = b.allocations;
      if (!allocs) { // oldest due first
        allocs = []; let left = b.amount;
        const open = await tx.purchaseBill.findMany({ where: { tenantId: t, supplierId: sup.id, status: { in: ['OPEN', 'PARTIALLY_PAID'] } }, orderBy: [{ dueDate: 'asc' }, { billDate: 'asc' }] });
        for (const bill of open) {
          if (left <= 0.001) break;
          const a = r2(Math.min(billDue(bill), left));
          if (a > 0) { allocs.push({ billId: bill.id, amount: a }); left = r2(left - a); }
        }
      }
      if (allocs.reduce((s, a) => s + a.amount, 0) > b.amount + 0.001) throw bad('Allocations exceed payment amount');
      for (const a of allocs) {
        const bill = await tx.purchaseBill.findFirst({ where: { id: a.billId, tenantId: t, supplierId: sup.id } });
        if (!bill || bill.status === 'CANCELLED') throw bad('Invalid bill in allocation');
        if (a.amount > billDue(bill) + 0.001) throw bad(`Allocation exceeds the balance of ${bill.number}`);
        const paid = r2(num(bill.paid) + a.amount);
        await tx.supplierPaymentAllocation.create({ data: { paymentId: payment.id, billId: bill.id, amount: a.amount } });
        await tx.purchaseBill.update({ where: { id: bill.id }, data: { paid, status: billStatus({ ...bill, paid }) } });
      }
      await post(tx, t, `Payment ${payment.number} to ${sup.name}`, 'SUPPLIER_PAYMENT', payment.id, [
        { accountId: sup.accountId ?? (await accountId(tx, t, '2100')), debit: b.amount },
        { accountId: await accountId(tx, t, b.mode === 'CASH' ? '1100' : '1200'), credit: b.amount },
      ], b.paidAt);
      return payment;
    });
    await audit(req, 'CREATE', 'SupplierPayment', p.id, { amount: b.amount, mode: b.mode, supplierId: b.supplierId });
    return p;
  });

  // ───── Debit notes to suppliers ─────
  app.get('/supplier-debit-notes', roles, async (req) =>
    prisma.supplierDebitNote.findMany({ where: { tenantId: tid(req) }, include: { supplier: { select: { name: true } }, bill: { select: { number: true, supplierBillNo: true } } }, orderBy: { issueDate: 'desc' }, take: 300 }));

  app.post('/supplier-debit-notes', roles, async (req) => {
    const b = z.object({
      billId: z.string(), reason: z.enum(['SHORT_SUPPLY', 'RATE_DIFFERENCE', 'OTHER']), reasonText: z.string().max(200).optional(),
      lines: z.array(z.object({ billLineId: z.string(), quantity: z.number().positive().optional(), rate: z.number().positive().optional(), amount: z.number().positive().optional() })).min(1),
    }).parse(req.body);
    const t = tid(req);
    const note = await prisma.$transaction(async (tx) => {
      const bill = await tx.purchaseBill.findFirst({ where: { id: b.billId, tenantId: t }, include: { supplier: true, lines: { include: { debitNoteLines: { where: { note: { status: 'ISSUED' } }, include: { note: { select: { reason: true } } } } } } } });
      if (!bill) throw notFound('Bill not found');
      if (bill.status === 'CANCELLED') throw bad('Bill is cancelled');
      const legs: Leg[] = [];
      const lines = [];
      for (const w of b.lines) {
        const l = bill.lines.find((x) => x.id === w.billLineId);
        if (!l) throw bad('Line is not on this bill');
        const doneTaxable = l.debitNoteLines.reduce((s, x) => s + num(x.taxable), 0);
        let quantity: number | null = null, rate: number;
        if (b.reason === 'SHORT_SUPPLY') {
          if (!l.materialId) throw bad('Short supply applies to material lines');
          const shortDone = l.debitNoteLines.filter((x) => x.note.reason === 'SHORT_SUPPLY').reduce((s, x) => s + num(x.quantity), 0);
          const open = num(l.claimQty) - shortDone;
          quantity = w.quantity ?? open; rate = num(l.rate);
          if (quantity <= 0 || quantity > open + 1e-9) throw bad(`${l.description}: billed ${num(l.quantity)} but received ${num(l.grnQty)} — at most ${r2(open)} ${l.unit} can be claimed as short supply`);
        } else if (b.reason === 'RATE_DIFFERENCE') {
          quantity = w.quantity ?? num(l.quantity); rate = w.rate ?? 0;
          if (rate <= 0) throw bad(`${l.description}: enter the rate difference`);
          if (quantity > num(l.quantity) + 1e-9) throw bad(`${l.description}: quantity cannot exceed the billed ${num(l.quantity)}`);
        } else { rate = w.amount ?? 0; if (rate <= 0) throw bad(`${l.description}: enter the amount`); }
        const tb = computeLine({ quantity: quantity ?? 1, rate, gstRate: num(l.gstRate) }, bill.interState, true);
        if (tb.taxable > r2(num(l.taxable) - doneTaxable) + 0.001) throw bad(`${l.description}: debit notes cannot exceed the line value ${num(l.taxable)}`);
        // where the value goes back
        if (b.reason === 'SHORT_SUPPLY') legs.push({ accountId: await accountId(tx, t, '1530'), credit: tb.taxable });
        else if (l.materialId) legs.push(...(await revalue(tx, t, l.materialId, -tb.taxable, num(l.grnQty))));
        else legs.push({ accountId: l.expenseAccountId!, credit: tb.taxable });
        lines.push({ billLineId: l.id, description: l.description, quantity, rate, gstRate: num(l.gstRate), taxable: tb.taxable, tax: r2(tb.cgst + tb.sgst + tb.igst), total: tb.total, tb });
      }
      const tot = sumBreakups(lines.map((l) => l.tb));
      const gst = r2(tot.cgst + tot.sgst + tot.igst);
      const total = r2(tot.taxable + (bill.rcm ? 0 : gst));
      legs.push({ accountId: await accountId(tx, t, '1500'), credit: gst }); // ITC reversed
      if (bill.rcm) legs.push({ accountId: await accountId(tx, t, '2230'), debit: gst });
      legs.push({ accountId: bill.supplier.accountId ?? (await accountId(tx, t, '2100')), debit: total });
      const applied = r2(Math.min(total, Math.max(0, billDue(bill))));
      const n = await tx.supplierDebitNote.create({ data: {
        tenantId: t, number: await nextNumber(tx, t, 'SDN'), billId: bill.id, supplierId: bill.supplierId, reason: b.reason, reasonText: b.reasonText,
        taxable: tot.taxable, cgst: tot.cgst, sgst: tot.sgst, igst: tot.igst, total, applied, createdById: req.user.sub,
        lines: { create: lines.map(({ tb: _tb, ...l }) => l) },
      } });
      await post(tx, t, `Debit note ${n.number} to ${bill.supplier.name} (bill ${bill.number})`, 'SUPPLIER_DEBIT_NOTE', n.id, legs);
      const debitNoted = r2(num(bill.debitNoted) + applied);
      await tx.purchaseBill.update({ where: { id: bill.id }, data: { debitNoted, status: billStatus({ ...bill, debitNoted }) } });
      return n;
    });
    await audit(req, 'ISSUE', 'SupplierDebitNote', note.id, { number: note.number, reason: b.reason, total: num(note.total) });
    return note;
  });

  app.post('/supplier-debit-notes/:id/cancel', roles, async (req) => {
    const { reason } = z.object({ reason: z.string().min(5) }).parse(req.body);
    const t = tid(req);
    await prisma.$transaction(async (tx) => {
      const n = await tx.supplierDebitNote.findFirst({ where: { id: idParam(req), tenantId: t }, include: { bill: true, lines: { include: { billLine: true } } } });
      if (!n) throw notFound();
      if (n.status === 'CANCELLED') throw bad('Already cancelled');
      const debitNoted = r2(num(n.bill.debitNoted) - num(n.applied));
      if (num(n.bill.payable) - num(n.bill.paid) - debitNoted < -0.001) throw bad('Payments already rely on this debit note — reverse them first');
      for (const l of n.lines) {
        if (n.reason !== 'SHORT_SUPPLY' && l.billLine.materialId) await revalue(tx, t, l.billLine.materialId, num(l.taxable), num(l.billLine.grnQty));
      }
      const j = await tx.journal.findFirst({ where: { tenantId: t, sourceType: 'SUPPLIER_DEBIT_NOTE', sourceId: n.id }, include: { entries: true } });
      if (j) await post(tx, t, `Cancel ${n.number}: ${reason}`, 'SUPPLIER_DEBIT_NOTE_CANCEL', n.id, j.entries.map((e) => ({ accountId: e.accountId, debit: num(e.credit), credit: num(e.debit) })));
      await tx.supplierDebitNote.update({ where: { id: n.id }, data: { status: 'CANCELLED', cancelReason: reason } });
      await tx.purchaseBill.update({ where: { id: n.billId }, data: { debitNoted, status: billStatus({ ...n.bill, debitNoted }) } });
    });
    await audit(req, 'CANCEL', 'SupplierDebitNote', idParam(req), { reason });
    return { ok: true };
  });

  // ───── Payables ageing ─────
  app.get('/payables', roles, async (req) => {
    const t = tid(req);
    const sups = await prisma.supplier.findMany({ where: { tenantId: t }, select: { id: true, name: true, phone: true, accountId: true } });
    const bills = await prisma.purchaseBill.findMany({ where: { tenantId: t, status: { in: ['OPEN', 'PARTIALLY_PAID'] } } });
    const sums = await prisma.journalEntry.groupBy({ by: ['accountId'], where: { accountId: { in: sups.flatMap((s) => (s.accountId ? [s.accountId] : [])) } }, _sum: { debit: true, credit: true } });
    const now = Date.now();
    return sups.map((s) => {
      const r = { supplier: { id: s.id, name: s.name, phone: s.phone }, current: 0, d30: 0, d60: 0, d90: 0, over90: 0, billed: 0, ledger: 0, unallocated: 0 };
      for (const b of bills.filter((x) => x.supplierId === s.id)) {
        const due = billDue(b), age = Math.floor((now - b.dueDate.getTime()) / 864e5);
        if (age <= 0) r.current += due; else if (age <= 30) r.d30 += due; else if (age <= 60) r.d60 += due; else if (age <= 90) r.d90 += due; else r.over90 += due;
        r.billed += due;
      }
      const x = sums.find((y) => y.accountId === s.accountId);
      r.ledger = r2(num(x?._sum.credit) - num(x?._sum.debit));
      // opening balances, old receipts posted before bills, advances, unapplied debit notes
      r.unallocated = r2(r.ledger - r.billed);
      return r;
    }).filter((r) => Math.abs(r.ledger) > 0.001 || r.billed > 0.001).sort((a, b) => b.ledger - a.ledger);
  });
}
