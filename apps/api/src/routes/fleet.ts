import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, num, type Tx } from '../lib/prisma.js';
import { requireRole, tid } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { bad, notFound } from '../lib/errors.js';
import { accountId, post } from '../lib/ledger.js';
import { nextNumber } from '../lib/numbering.js';

const DAY = 864e5;
const r2 = (n: number) => Math.round(n * 100) / 100;
/** Due within this many days / km counts as "due soon". */
const SOON_DAYS = 7, SOON_KM = 500;

type Sched = { everyKm: number | null; everyDays: number | null; lastDoneAt: Date | null; lastDoneKm: number | null; createdAt: Date };
export function dueStatus(s: Sched, odometerKm: number | null, now = new Date()) {
  const from = s.lastDoneAt ?? s.createdAt;
  const dueAt = s.everyDays ? new Date(from.getTime() + s.everyDays * DAY) : null;
  const dueKm = s.everyKm != null && s.lastDoneKm != null ? s.lastDoneKm + s.everyKm : null;
  const daysLeft = dueAt ? Math.ceil((dueAt.getTime() - now.getTime()) / DAY) : null;
  const kmLeft = dueKm != null && odometerKm != null ? dueKm - odometerKm : null;
  const status =
    (daysLeft != null && daysLeft < 0) || (kmLeft != null && kmLeft < 0) ? 'OVERDUE'
    : (daysLeft != null && daysLeft <= SOON_DAYS) || (kmLeft != null && kmLeft <= SOON_KM) ? 'DUE_SOON'
    : s.everyKm != null && s.lastDoneKm == null && !s.everyDays ? 'NO_BASELINE' : 'OK';
  return { dueAt, dueKm, daysLeft, kmLeft, status };
}

/** Moves a schedule's "last done" to its latest live record (after a new record or a cancel). */
async function refreshSchedule(tx: Tx, scheduleId: string) {
  const last = await tx.maintenanceRecord.findFirst({ where: { scheduleId, cancelledAt: null }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] });
  await tx.maintenanceSchedule.update({ where: { id: scheduleId }, data: { lastDoneAt: last?.date ?? null, lastDoneKm: last?.odometerKm ?? null } });
}

export default async function (app: FastifyInstance) {
  const view = { preHandler: requireRole('MANAGER', 'DISPATCH', 'ACCOUNTANT') };
  const edit = { preHandler: requireRole('MANAGER', 'DISPATCH') };

  /** Every truck with its schedules, what is due, and what it cost in the period. */
  app.get('/fleet/maintenance', view, async (req) => {
    const t = tid(req);
    const q = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }).parse(req.query);
    const to = q.to ?? new Date();
    const from = q.from ?? new Date(to.getFullYear(), to.getMonth() >= 3 ? 3 : -9, 1); // FY start (1 Apr)
    const [vehicles, records, challans] = await Promise.all([
      prisma.vehicle.findMany({ where: { tenantId: t }, orderBy: { number: 'asc' }, include: { maintenanceSchedules: { where: { active: true }, orderBy: { task: 'asc' } } } }),
      prisma.maintenanceRecord.groupBy({ by: ['vehicleId'], where: { tenantId: t, cancelledAt: null, date: { gte: from, lte: to } }, _sum: { totalCost: true, downtimeHrs: true }, _count: true }),
      prisma.challan.groupBy({ by: ['vehicleId'], where: { tenantId: t, status: { not: 'CANCELLED' }, createdAt: { gte: from, lte: to } }, _sum: { dieselCost: true, quantityM3: true }, _count: true }),
    ]);
    const rec = new Map(records.map((r) => [r.vehicleId, r]));
    const ch = new Map(challans.map((c) => [c.vehicleId, c]));
    return {
      from, to,
      vehicles: vehicles.map((v) => {
        const r = rec.get(v.id), c = ch.get(v.id);
        const maintenance = num(r?._sum.totalCost), diesel = num(c?._sum.dieselCost), m3 = num(c?._sum.quantityM3);
        const schedules = v.maintenanceSchedules.map((s) => ({ ...s, ...dueStatus(s, v.odometerKm) }));
        const worst = schedules.some((s) => s.status === 'OVERDUE') ? 'OVERDUE' : schedules.some((s) => s.status === 'DUE_SOON') ? 'DUE_SOON' : 'OK';
        return {
          id: v.id, number: v.number, type: v.type, active: v.active, odometerKm: v.odometerKm, status: worst, schedules,
          cost: { maintenance, diesel, total: r2(maintenance + diesel), services: r?._count ?? 0, downtimeHrs: num(r?._sum.downtimeHrs), trips: c?._count ?? 0, m3, perM3: m3 ? r2((maintenance + diesel) / m3) : null },
        };
      }),
    };
  });

  app.post('/vehicles/:id/odometer', edit, async (req) => {
    const { id } = req.params as { id: string };
    const { km } = z.object({ km: z.number().int().min(0).max(5_000_000) }).parse(req.body);
    const v = await prisma.vehicle.findFirst({ where: { id, tenantId: tid(req) } });
    if (!v) throw notFound('Truck not found');
    if (v.odometerKm != null && km < v.odometerKm) throw bad(`Odometer cannot go back (last reading ${v.odometerKm} km)`);
    return prisma.vehicle.update({ where: { id }, data: { odometerKm: km } });
  });

  // ───── Schedules ─────
  const schedSchema = z.object({
    vehicleId: z.string(), task: z.string().trim().min(2).max(100),
    everyKm: z.number().int().positive().nullish(), everyDays: z.number().int().positive().nullish(),
    lastDoneAt: z.coerce.date().nullish(), lastDoneKm: z.number().int().min(0).nullish(),
  }).refine((s) => s.everyKm || s.everyDays, 'Give an interval in km, in days, or both');

  app.post('/fleet/schedules', edit, async (req) => {
    const b = schedSchema.parse(req.body);
    const t = tid(req);
    const v = await prisma.vehicle.findFirst({ where: { id: b.vehicleId, tenantId: t } });
    if (!v) throw notFound('Truck not found');
    const s = await prisma.maintenanceSchedule.create({ data: { ...b, tenantId: t, lastDoneKm: b.lastDoneKm ?? (b.everyKm ? v.odometerKm : null) } });
    await audit(req, 'CREATE', 'MaintenanceSchedule', s.id, b);
    return s;
  });

  /** Apply a standard set of tasks to every active transit mixer that doesn't have them yet. */
  app.post('/fleet/schedules/template', edit, async (req) => {
    const t = tid(req);
    const TEMPLATE = [
      { task: 'Engine oil + filter', everyKm: 10000, everyDays: 180 },
      { task: 'Drum gearbox oil', everyDays: 365 },
      { task: 'Hydraulic oil + filter', everyDays: 365 },
      { task: 'Grease drum rollers & joints', everyDays: 7 },
      { task: 'Tyre rotation', everyKm: 10000 },
      { task: 'Insurance renewal', everyDays: 365 },
      { task: 'Fitness certificate', everyDays: 365 },
      { task: 'Pollution (PUC)', everyDays: 180 },
    ];
    const vs = await prisma.vehicle.findMany({ where: { tenantId: t, active: true, type: 'TRANSIT_MIXER' }, include: { maintenanceSchedules: true } });
    let created = 0;
    for (const v of vs) for (const x of TEMPLATE) {
      if (v.maintenanceSchedules.some((s) => s.task === x.task)) continue;
      await prisma.maintenanceSchedule.create({ data: { tenantId: t, vehicleId: v.id, task: x.task, everyKm: x.everyKm ?? null, everyDays: x.everyDays ?? null, lastDoneKm: x.everyKm ? v.odometerKm : null } });
      created++;
    }
    await audit(req, 'CREATE', 'MaintenanceSchedule', undefined, { template: true, created });
    return { created };
  });

  app.put('/fleet/schedules/:id', edit, async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ task: z.string().trim().min(2).max(100), everyKm: z.number().int().positive().nullable(), everyDays: z.number().int().positive().nullable(), active: z.boolean() }).partial().parse(req.body);
    const s = await prisma.maintenanceSchedule.findFirst({ where: { id, tenantId: tid(req) } });
    if (!s) throw notFound();
    if ((b.everyKm === null || (b.everyKm === undefined && !s.everyKm)) && (b.everyDays === null || (b.everyDays === undefined && !s.everyDays))) throw bad('Give an interval in km, in days, or both');
    const u = await prisma.maintenanceSchedule.update({ where: { id }, data: b });
    await audit(req, 'UPDATE', 'MaintenanceSchedule', id, b);
    return u;
  });

  // ───── Service records ─────
  app.get('/fleet/records', view, async (req) => {
    const q = z.object({ vehicleId: z.string().optional() }).parse(req.query);
    return prisma.maintenanceRecord.findMany({ where: { tenantId: tid(req), ...(q.vehicleId ? { vehicleId: q.vehicleId } : {}) }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 300, include: { vehicle: { select: { number: true } }, schedule: { select: { task: true } } } });
  });

  app.post('/fleet/records', edit, async (req) => {
    const b = z.object({
      vehicleId: z.string(), scheduleId: z.string().nullish(), date: z.coerce.date(), odometerKm: z.number().int().min(0).nullish(),
      description: z.string().trim().min(2).max(300), vendor: z.string().trim().max(100).nullish(),
      partsCost: z.number().min(0).default(0), labourCost: z.number().min(0).default(0),
      paidVia: z.enum(['CASH', 'BANK', 'PURCHASE_BILL']), billRef: z.string().trim().max(60).nullish(), downtimeHrs: z.number().min(0).max(10000).nullish(),
    }).parse(req.body);
    const t = tid(req);
    if (b.date.getTime() > Date.now() + DAY) throw bad('Service date cannot be in the future');
    if (b.paidVia === 'PURCHASE_BILL' && !b.billRef) throw bad('Enter the purchase bill number this cost was booked on');
    const total = r2(b.partsCost + b.labourCost);
    const rec = await prisma.$transaction(async (tx) => {
      const v = await tx.vehicle.findFirst({ where: { id: b.vehicleId, tenantId: t } });
      if (!v) throw notFound('Truck not found');
      if (b.scheduleId && !(await tx.maintenanceSchedule.findFirst({ where: { id: b.scheduleId, vehicleId: v.id } }))) throw bad('That service task belongs to another truck');
      const number = await nextNumber(tx, t, 'SRV', b.date);
      const r = await tx.maintenanceRecord.create({ data: { ...b, tenantId: t, number, totalCost: total, createdById: req.user.sub } });
      if (total > 0 && b.paidVia !== 'PURCHASE_BILL') {
        const exp = await accountId(tx, t, '5310'), pay = await accountId(tx, t, b.paidVia === 'CASH' ? '1100' : '1200');
        await post(tx, t, `Service ${number} · ${v.number} · ${b.description}`, 'VEHICLE_SERVICE', r.id, [{ accountId: exp, debit: total }, { accountId: pay, credit: total }], b.date);
      }
      if (b.odometerKm != null && (v.odometerKm == null || b.odometerKm > v.odometerKm)) await tx.vehicle.update({ where: { id: v.id }, data: { odometerKm: b.odometerKm } });
      if (b.scheduleId) await refreshSchedule(tx, b.scheduleId);
      return r;
    });
    await audit(req, 'CREATE', 'MaintenanceRecord', rec.id, { ...b, totalCost: total });
    return rec;
  });

  app.post('/fleet/records/:id/cancel', edit, async (req) => {
    const { id } = req.params as { id: string };
    const { reason } = z.object({ reason: z.string().trim().min(3) }).parse(req.body);
    const t = tid(req);
    await prisma.$transaction(async (tx) => {
      const r = await tx.maintenanceRecord.findFirst({ where: { id, tenantId: t } });
      if (!r) throw notFound();
      if (r.cancelledAt) throw bad('Already cancelled');
      await tx.maintenanceRecord.update({ where: { id }, data: { cancelledAt: new Date(), cancelReason: reason } });
      const j = await tx.journal.findFirst({ where: { tenantId: t, sourceType: 'VEHICLE_SERVICE', sourceId: id }, include: { entries: true } });
      if (j) await post(tx, t, `Service ${r.number} cancelled: ${reason}`, 'VEHICLE_SERVICE_CANCEL', id, j.entries.map((e) => ({ accountId: e.accountId, debit: num(e.credit), credit: num(e.debit) })));
      if (r.scheduleId) await refreshSchedule(tx, r.scheduleId);
    });
    await audit(req, 'CANCEL', 'MaintenanceRecord', id, { reason });
    return { ok: true };
  });
}
