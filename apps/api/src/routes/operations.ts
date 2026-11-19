import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TRIP_STATES } from '@onrmc/shared';
import { prisma, num } from '../lib/prisma.js';
import { requireRole, tid } from '../lib/auth.js';
import { nextNumber } from '../lib/numbering.js';
import { accountId, post } from '../lib/ledger.js';
import { audit } from '../lib/audit.js';
import { bad, notFound } from '../lib/errors.js';
import { broadcast } from './gps.js';
import { syncChallanDiesel } from '../lib/diesel.js';

const idParam = (req: { params: unknown }) => (req.params as { id: string }).id;

export default async function (app: FastifyInstance) {
  // ───── Orders ─────
  app.get('/orders', { preHandler: requireRole('MANAGER', 'SALES', 'DISPATCH', 'BATCHING', 'ACCOUNTANT') }, async (req) => {
    const { status, date } = req.query as { status?: string; date?: string };
    const day = date ? new Date(date) : undefined;
    return prisma.order.findMany({
      where: {
        tenantId: tid(req),
        ...(status ? { status: status as never } : {}),
        ...(day ? { scheduledAt: { gte: day, lt: new Date(day.getTime() + 864e5) } } : {}),
      },
      include: { customer: { select: { name: true } }, site: { select: { name: true } }, mixDesign: { select: { grade: true } }, challans: { select: { quantityM3: true, status: true } } },
      orderBy: { scheduledAt: 'desc' }, take: 200,
    });
  });

  app.post('/orders', { preHandler: requireRole('MANAGER', 'SALES') }, async (req) => {
    const b = z.object({
      customerId: z.string(), siteId: z.string(), mixDesignId: z.string(), quantityM3: z.number().positive(),
      rate: z.number().positive().optional(), pumpRequired: z.boolean().default(false), pumpCharge: z.number().default(0),
      scheduledAt: z.coerce.date(), notes: z.string().optional(),
    }).parse(req.body);
    const t = tid(req);
    // default rate: customer-specific rate, else mix base rate
    let rate = b.rate;
    if (!rate) {
      const cr = await prisma.customerRate.findFirst({ where: { tenantId: t, customerId: b.customerId, mixDesignId: b.mixDesignId }, orderBy: { validFrom: 'desc' } });
      const mix = await prisma.mixDesign.findFirstOrThrow({ where: { id: b.mixDesignId, tenantId: t } });
      rate = num(cr?.rate ?? mix.baseRate);
    }
    const o = await prisma.$transaction(async (tx) =>
      tx.order.create({ data: { ...b, rate, tenantId: t, number: await nextNumber(tx, t, 'SO') } }));
    await audit(req, 'CREATE', 'Order', o.id);
    return o;
  });

  app.post('/orders/:id/status', { preHandler: requireRole('MANAGER', 'SALES', 'DISPATCH') }, async (req) => {
    const { status } = z.object({ status: z.enum(['DRAFT', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']) }).parse(req.body);
    const r = await prisma.order.updateMany({ where: { id: idParam(req), tenantId: tid(req) }, data: { status } });
    if (!r.count) throw notFound();
    return { ok: true };
  });

  // ───── Material receipts (GRN) — updates stock, weighted avg cost, supplier ledger ─────
  app.get('/receipts', { preHandler: requireRole('MANAGER', 'STORE', 'ACCOUNTANT') }, async (req) => {
    const { unbilled, supplierId } = req.query as { unbilled?: string; supplierId?: string };
    return prisma.materialReceipt.findMany({
      where: { tenantId: tid(req), ...(supplierId ? { supplierId } : {}), ...(unbilled === '1' ? { billId: null, legacyPosted: false } : {}) },
      include: { supplier: { select: { name: true } }, bill: { select: { id: true, number: true } }, lines: { include: { material: { select: { name: true, unit: true } } } } },
      orderBy: { receivedAt: 'desc' }, take: 200,
    });
  });

  app.post('/receipts', { preHandler: requireRole('MANAGER', 'STORE') }, async (req) => {
    const b = z.object({
      plantId: z.string(), supplierId: z.string(), supplierBillNo: z.string().optional(), vehicleNo: z.string().optional(),
      lines: z.array(z.object({ materialId: z.string(), quantity: z.number().positive(), rate: z.number().nonnegative() })).min(1),
    }).parse(req.body);
    const t = tid(req);
    const r = await prisma.$transaction(async (tx) => {
      const amount = b.lines.reduce((s, l) => s + l.quantity * l.rate, 0);
      const receipt = await tx.materialReceipt.create({
        data: { tenantId: t, plantId: b.plantId, supplierId: b.supplierId, supplierBillNo: b.supplierBillNo, vehicleNo: b.vehicleNo, number: await nextNumber(tx, t, 'GRN'), amount, lines: { create: b.lines } },
      });
      for (const l of b.lines) {
        const mat = await tx.material.findFirstOrThrow({ where: { id: l.materialId, tenantId: t } });
        const totalStock = await tx.stock.aggregate({ where: { materialId: mat.id }, _sum: { quantity: true } });
        const oldQty = Math.max(0, num(totalStock._sum.quantity));
        const avg = (oldQty * num(mat.avgCost) + l.quantity * l.rate) / (oldQty + l.quantity);
        await tx.material.update({ where: { id: mat.id }, data: { avgCost: avg } });
        await tx.stock.upsert({
          where: { plantId_materialId: { plantId: b.plantId, materialId: mat.id } },
          create: { tenantId: t, plantId: b.plantId, materialId: mat.id, quantity: l.quantity },
          update: { quantity: { increment: l.quantity } },
        });
      }
      await tx.supplier.findFirstOrThrow({ where: { id: b.supplierId, tenantId: t } });
      // Stock comes in at the GRN rate; the supplier is credited when their bill is entered (Purchases → bills).
      await post(tx, t, `Goods received ${receipt.number}`, 'RECEIPT', receipt.id, [
        { accountId: await accountId(tx, t, '1400'), debit: Math.round(amount * 100) / 100 },
        { accountId: await accountId(tx, t, '2150'), credit: Math.round(amount * 100) / 100 },
      ]);
      return receipt;
    });
    await audit(req, 'CREATE', 'MaterialReceipt', r.id);
    return r;
  });

  // ───── Batching — records actual consumption, deducts stock, snapshots cost ─────
  app.get('/batches', { preHandler: requireRole('MANAGER', 'BATCHING', 'DISPATCH') }, async (req) =>
    prisma.batch.findMany({
      where: { tenantId: tid(req) },
      include: { order: { select: { number: true, customer: { select: { name: true } }, mixDesign: { select: { grade: true } } } }, consumption: { include: { material: { select: { name: true, unit: true } } } }, challan: { select: { number: true, status: true } } },
      orderBy: { batchedAt: 'desc' }, take: 200,
    }));

  app.post('/batches', { preHandler: requireRole('MANAGER', 'BATCHING') }, async (req) => {
    const b = z.object({
      orderId: z.string(), plantId: z.string(), quantityM3: z.number().positive().max(12),
      /** Actual weights from the batching plant. Missing materials default to design qty. */
      actuals: z.record(z.string(), z.number().nonnegative()).default({}),
    }).parse(req.body);
    const t = tid(req);
    const batch = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({ where: { id: b.orderId, tenantId: t }, include: { mixDesign: { include: { items: { include: { material: true } } } } } });
      if (!order) throw notFound('Order not found');
      if (order.status === 'CANCELLED' || order.status === 'COMPLETED') throw bad('Order is closed');
      const created = await tx.batch.create({ data: { tenantId: t, plantId: b.plantId, orderId: order.id, number: await nextNumber(tx, t, 'BT'), quantityM3: b.quantityM3, operatorId: req.user.sub } });
      let totalCost = 0;
      for (const it of order.mixDesign.items) {
        const design = num(it.qtyPerM3) * b.quantityM3;
        const actual = b.actuals[it.materialId] ?? design;
        // weighted average cost at this moment, rounded to paise so the ledger equals the stored snapshot
        const cost = Math.round(actual * num(it.material.avgCost) * 100) / 100;
        totalCost += cost;
        await tx.batchConsumption.create({ data: { batchId: created.id, materialId: it.materialId, designQty: design, actualQty: actual, cost } });
        await tx.stock.upsert({
          where: { plantId_materialId: { plantId: b.plantId, materialId: it.materialId } },
          create: { tenantId: t, plantId: b.plantId, materialId: it.materialId, quantity: -actual },
          update: { quantity: { decrement: actual } },
        });
      }
      // Books: materials leave inventory and become cost of materials consumed.
      totalCost = Math.round(totalCost * 100) / 100;
      await post(tx, t, `Materials consumed ${created.number}`, 'BATCH', created.id, [
        { accountId: await accountId(tx, t, '5000'), debit: totalCost },
        { accountId: await accountId(tx, t, '1400'), credit: totalCost },
      ], created.batchedAt);
      if (order.status === 'CONFIRMED') await tx.order.update({ where: { id: order.id }, data: { status: 'IN_PROGRESS' } });
      return created;
    });
    await audit(req, 'CREATE', 'Batch', batch.id);
    return batch;
  });

  /** Cancel a batch entered by mistake (no challan yet): restores stock and reverses the cost posting. */
  app.post('/batches/:id/cancel', { preHandler: requireRole('MANAGER', 'BATCHING') }, async (req) => {
    const { reason } = z.object({ reason: z.string().min(5) }).parse(req.body);
    const t = tid(req);
    await prisma.$transaction(async (tx) => {
      const batch = await tx.batch.findFirst({ where: { id: idParam(req), tenantId: t }, include: { challan: true, consumption: true } });
      if (!batch) throw notFound('Batch not found');
      if (batch.cancelledAt) throw bad('Batch is already cancelled');
      if (batch.challan) throw bad('This batch has a challan. Concrete that left the plant was consumed — cancel the challan or record a return instead.');
      for (const c of batch.consumption) {
        await tx.stock.update({ where: { plantId_materialId: { plantId: batch.plantId, materialId: c.materialId } }, data: { quantity: { increment: c.actualQty } } });
      }
      const j = await tx.journal.findFirst({ where: { tenantId: t, sourceType: 'BATCH', sourceId: batch.id }, include: { entries: true } });
      if (j) await post(tx, t, `Cancel ${batch.number}: ${reason}`, 'BATCH_CANCEL', batch.id, j.entries.map((e) => ({ accountId: e.accountId, debit: num(e.credit), credit: num(e.debit) })));
      await tx.batch.update({ where: { id: batch.id }, data: { cancelledAt: new Date(), cancelReason: reason } });
    });
    await audit(req, 'CANCEL', 'Batch', idParam(req), { reason });
    return { ok: true };
  });

  // ───── Delivery challans (trips) ─────
  /** One challan with everything its printed copy needs (plant letterhead and logo, customer, site, mix, truck). */
  app.get('/challans/:id', { preHandler: requireRole('MANAGER', 'DISPATCH', 'ACCOUNTANT', 'SALES', 'BATCHING') }, async (req) => {
    const c = await prisma.challan.findFirst({
      where: { id: (req.params as { id: string }).id, tenantId: tid(req) },
      include: {
        order: { include: { customer: { select: { name: true, gstin: true, phone: true, billingAddress: true } }, site: true, mixDesign: { select: { grade: true, name: true } } } },
        vehicle: { select: { number: true } }, driver: { select: { name: true, phone: true } },
        batch: { select: { number: true, batchedAt: true, plant: { select: { name: true, address: true } } } },
        ewayBills: { where: { status: 'ACTIVE' }, select: { ewbNo: true, validUpto: true } },
        invoiceLine: { select: { invoice: { select: { number: true } } } },
      },
    });
    if (!c) throw notFound('Challan not found');
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tid(req) }, select: { name: true, legalName: true, gstin: true, address: true, city: true, pincode: true, phone: true, email: true, logoUrl: true } });
    return { ...c, tenant };
  });

  app.get('/challans', { preHandler: requireRole('MANAGER', 'DISPATCH', 'ACCOUNTANT', 'SALES') }, async (req) => {
    const { status, uninvoiced, customerId } = req.query as { status?: string; uninvoiced?: string; customerId?: string };
    return prisma.challan.findMany({
      where: {
        tenantId: tid(req), ...(status ? { status } : {}),
        ...(uninvoiced === '1' ? { invoiceLine: null, status: { in: ['DELIVERED', 'RETURNED'] } } : {}),
        ...(customerId ? { order: { customerId } } : {}),
      },
      include: { order: { include: { customer: { select: { name: true } }, site: { select: { name: true } }, mixDesign: { select: { grade: true } } } }, vehicle: { select: { number: true } }, driver: { select: { name: true, phone: true } } },
      orderBy: { createdAt: 'desc' }, take: 300,
    });
  });

  app.post('/challans', { preHandler: requireRole('MANAGER', 'DISPATCH') }, async (req) => {
    const b = z.object({ batchId: z.string(), vehicleId: z.string(), driverId: z.string().optional() }).parse(req.body);
    const t = tid(req);
    const c = await prisma.$transaction(async (tx) => {
      const batch = await tx.batch.findFirst({ where: { id: b.batchId, tenantId: t }, include: { challan: true } });
      if (!batch) throw notFound('Batch not found');
      if (batch.cancelledAt) throw bad('This batch was cancelled');
      if (batch.challan) throw bad('This batch already has a challan');
      // Delivered quantity is the batched quantity — the invoice later bills exactly this.
      return tx.challan.create({ data: { tenantId: t, number: await nextNumber(tx, t, 'DC'), orderId: batch.orderId, batchId: batch.id, vehicleId: b.vehicleId, driverId: b.driverId, quantityM3: batch.quantityM3 } });
    });
    await audit(req, 'CREATE', 'Challan', c.id);
    broadcast(t, { type: 'challan', id: c.id, status: c.status });
    return c;
  });

  const statusBody = z.object({ status: z.enum(TRIP_STATES), podName: z.string().optional(), dieselCost: z.number().optional() });
  async function setStatus(tenantId: string, id: string, body: z.infer<typeof statusBody>, driverId?: string) {
    const c = await prisma.challan.findFirst({ where: { id, tenantId, ...(driverId ? { driverId } : {}) }, include: { invoiceLine: { select: { id: true } } } });
    if (!c) throw notFound();
    // A billed challan is locked (it backs an issued invoice); only the truck's return may still be recorded.
    if (c.invoiceLine && !(c.status === 'DELIVERED' && body.status === 'RETURNED')) throw bad('This challan is already invoiced. Cancel the invoice first.');
    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.challan.update({
        where: { id },
        data: {
          status: body.status, podName: body.podName ?? c.podName, dieselCost: body.dieselCost ?? c.dieselCost,
          ...(body.status === 'IN_TRANSIT' && !c.dispatchedAt ? { dispatchedAt: now } : {}),
          ...(body.status === 'DELIVERED' ? { deliveredAt: now } : {}),
        },
      });
      await syncChallanDiesel(tx, tenantId, u);
      return u;
    });
    broadcast(tenantId, { type: 'challan', id, status: body.status });
    return updated;
  }
  /** Diesel can be corrected at any time, even after billing — it is a cost, not part of the invoice. */
  app.patch('/challans/:id/diesel', { preHandler: requireRole('MANAGER', 'DISPATCH', 'ACCOUNTANT') }, async (req) => {
    const { dieselCost } = z.object({ dieselCost: z.number().nonnegative() }).parse(req.body);
    const t = tid(req);
    const u = await prisma.$transaction(async (tx) => {
      const c = await tx.challan.findFirst({ where: { id: idParam(req), tenantId: t } });
      if (!c) throw notFound();
      if (c.status === 'CANCELLED') throw bad('Challan is cancelled');
      const upd = await tx.challan.update({ where: { id: c.id }, data: { dieselCost } });
      await syncChallanDiesel(tx, t, upd);
      return upd;
    });
    await audit(req, 'UPDATE', 'ChallanDiesel', u.id, { dieselCost });
    return u;
  });

  app.post('/challans/:id/status', { preHandler: requireRole('MANAGER', 'DISPATCH') }, async (req) =>
    setStatus(tid(req), idParam(req), statusBody.parse(req.body)));

  // ───── Driver app endpoints ─────
  app.get('/driver/trips', { preHandler: requireRole('DRIVER') }, async (req) =>
    prisma.challan.findMany({
      where: { tenantId: tid(req), driverId: req.user.sub, status: { notIn: ['RETURNED', 'CANCELLED'] } },
      include: { order: { include: { customer: { select: { name: true, phone: true } }, site: true, mixDesign: { select: { grade: true } } } }, vehicle: { select: { id: true, number: true } } },
      orderBy: { createdAt: 'asc' },
    }));
  app.post('/driver/trips/:id/status', { preHandler: requireRole('DRIVER') }, async (req) =>
    setStatus(tid(req), idParam(req), statusBody.parse(req.body), req.user.sub));
}
