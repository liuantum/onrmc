import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireRole, tid } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { bad, notFound } from '../lib/errors.js';
import { gstinError } from '../lib/einvoice/validate.js';

const pin = z.string().regex(/^[1-9][0-9]{5}$/, 'PIN code must be 6 digits');
/** Rejects GSTINs with a bad format or check digit; normalises to upper case. */
const gstin = z.string().transform((v) => v.trim().toUpperCase()).refine((v) => v === '' || !gstinError(v, ''), (v) => ({ message: gstinError(v, '')?.trim() ?? 'Invalid GSTIN' })).transform((v) => v || null);

const idParam = (req: { params: unknown }) => (req.params as { id: string }).id;

export default async function (app: FastifyInstance) {
  // ── Customers ──
  const customer = z.object({
    name: z.string().min(1), gstin: gstin.optional().nullable(), stateCode: z.string().length(2),
    city: z.string().optional().nullable(), pincode: pin.optional().nullable(),
    phone: z.string().optional().nullable(), email: z.string().optional().nullable(),
    billingAddress: z.string().optional().nullable(), creditLimit: z.number().default(0), creditDays: z.number().int().default(30),
  });
  app.get('/customers', { preHandler: requireRole('MANAGER', 'SALES', 'ACCOUNTANT', 'DISPATCH') }, async (req) => {
    const q = (req.query as { q?: string }).q;
    return prisma.customer.findMany({
      where: { tenantId: tid(req), ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}) },
      include: { sites: true }, orderBy: { name: 'asc' },
    });
  });
  app.get('/customers/:id', { preHandler: requireRole('MANAGER', 'SALES', 'ACCOUNTANT') }, async (req) => {
    const c = await prisma.customer.findFirst({ where: { id: idParam(req), tenantId: tid(req) }, include: { sites: true, rates: { include: { mixDesign: true } } } });
    if (!c) throw notFound();
    return c;
  });
  app.post('/customers', { preHandler: requireRole('MANAGER', 'SALES', 'ACCOUNTANT') }, async (req) => {
    const b = customer.parse(req.body);
    const t = tid(req);
    const c = await prisma.$transaction(async (tx) => {
      // each customer gets its own ledger under Sundry Debtors
      const n = await tx.account.count({ where: { tenantId: t, group: 'Sundry Debtors', system: false } });
      const acc = await tx.account.create({ data: { tenantId: t, code: `13${String(n + 1).padStart(4, '0')}`, name: b.name, type: 'ASSET', group: 'Sundry Debtors' } });
      return tx.customer.create({ data: { ...b, tenantId: t, accountId: acc.id } });
    });
    await audit(req, 'CREATE', 'Customer', c.id);
    return c;
  });
  app.put('/customers/:id', { preHandler: requireRole('MANAGER', 'SALES', 'ACCOUNTANT') }, async (req) => {
    const r = await prisma.customer.updateMany({ where: { id: idParam(req), tenantId: tid(req) }, data: customer.partial().parse(req.body) });
    if (!r.count) throw notFound();
    return { ok: true };
  });
  app.post('/customers/:id/sites', { preHandler: requireRole('MANAGER', 'SALES') }, async (req) => {
    const b = z.object({ name: z.string(), address: z.string().optional(), city: z.string().optional(), pincode: pin.optional(), stateCode: z.string().length(2), lat: z.number().optional(), lng: z.number().optional(), contact: z.string().optional() }).parse(req.body);
    const c = await prisma.customer.findFirst({ where: { id: idParam(req), tenantId: tid(req) } });
    if (!c) throw notFound();
    return prisma.site.create({ data: { ...b, tenantId: tid(req), customerId: c.id } });
  });
  app.post('/customers/:id/rates', { preHandler: requireRole('MANAGER') }, async (req) => {
    const b = z.object({ mixDesignId: z.string(), rate: z.number().positive() }).parse(req.body);
    return prisma.customerRate.create({ data: { ...b, tenantId: tid(req), customerId: idParam(req) } });
  });

  // ── Suppliers: see purchases.ts ──

  // ── Plants ──
  app.get('/plants', { preHandler: requireRole('MANAGER', 'STORE', 'BATCHING', 'DISPATCH', 'ACCOUNTANT', 'SALES') }, async (req) =>
    prisma.plant.findMany({ where: { tenantId: tid(req) } }));
  app.post('/plants', { preHandler: requireRole('OWNER') }, async (req) => {
    const b = z.object({ name: z.string(), address: z.string().optional(), pincode: pin.optional(), lat: z.number().optional(), lng: z.number().optional() }).parse(req.body);
    const t = tid(req);
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: t }, include: { subscriptions: { orderBy: { endsAt: 'desc' }, take: 1, include: { plan: true } }, _count: { select: { plants: true } } } });
    const limit = tenant.subscriptions[0]?.plan.maxPlants ?? 1;
    if (tenant._count.plants >= limit) throw bad(`Your plan allows ${limit} plant(s). Upgrade to add more.`);
    return prisma.plant.create({ data: { ...b, tenantId: t } });
  });

  // ── Materials & stock ──
  app.get('/materials', { preHandler: requireRole('MANAGER', 'STORE', 'BATCHING') }, async (req) =>
    prisma.material.findMany({ where: { tenantId: tid(req) }, include: { stock: { include: { plant: { select: { name: true } } } } }, orderBy: { name: 'asc' } }));
  app.post('/materials', { preHandler: requireRole('MANAGER', 'STORE') }, async (req) => {
    const b = z.object({
      name: z.string(), unit: z.string(), reorderLevel: z.number().default(0),
      kind: z.enum(['CEMENT', 'FLY_ASH', 'GGBS', 'AGGREGATE_10MM', 'AGGREGATE_20MM', 'SAND', 'M_SAND', 'ADMIXTURE', 'WATER', 'OTHER']),
    }).parse(req.body);
    return prisma.material.create({ data: { ...b, tenantId: tid(req) } });
  });

  // ── Mix designs (grades) ──
  app.get('/mix-designs', { preHandler: requireRole('MANAGER', 'SALES', 'BATCHING', 'DISPATCH', 'ACCOUNTANT') }, async (req) =>
    prisma.mixDesign.findMany({ where: { tenantId: tid(req) }, include: { items: { include: { material: true } } }, orderBy: { grade: 'asc' } }));
  app.post('/mix-designs', { preHandler: requireRole('MANAGER') }, async (req) => {
    const b = z.object({
      grade: z.string(), name: z.string(), baseRate: z.number().positive(), gstRate: z.number().default(18),
      items: z.array(z.object({ materialId: z.string(), qtyPerM3: z.number().nonnegative() })),
    }).parse(req.body);
    return prisma.mixDesign.create({ data: { tenantId: tid(req), grade: b.grade, name: b.name, baseRate: b.baseRate, gstRate: b.gstRate, items: { create: b.items } }, include: { items: true } });
  });

  // ── Vehicles ──
  app.get('/vehicles', { preHandler: requireRole('MANAGER', 'DISPATCH') }, async (req) =>
    prisma.vehicle.findMany({ where: { tenantId: tid(req) }, orderBy: { number: 'asc' } }));
  app.post('/vehicles', { preHandler: requireRole('MANAGER', 'DISPATCH') }, async (req) => {
    const b = z.object({ number: z.string(), type: z.enum(['TRANSIT_MIXER', 'PUMP', 'TIPPER', 'OTHER']).default('TRANSIT_MIXER'), capacityM3: z.number().default(6) }).parse(req.body);
    return prisma.vehicle.create({ data: { ...b, tenantId: tid(req) } });
  });

  // ── Staff users ──
  app.get('/users', { preHandler: requireRole('OWNER', 'MANAGER') }, async (req) =>
    prisma.user.findMany({ where: { tenantId: tid(req) }, select: { id: true, name: true, phone: true, role: true, active: true, plantId: true }, orderBy: { name: 'asc' } }));
  app.post('/users', { preHandler: requireRole('OWNER') }, async (req) => {
    const b = z.object({
      name: z.string(), phone: z.string().min(10), password: z.string().min(8), plantId: z.string().optional(),
      role: z.enum(['MANAGER', 'ACCOUNTANT', 'SALES', 'STORE', 'BATCHING', 'DISPATCH', 'DRIVER']),
    }).parse(req.body);
    const u = await prisma.user.create({ data: { tenantId: tid(req), name: b.name, phone: b.phone, role: b.role, plantId: b.plantId, passwordHash: await bcrypt.hash(b.password, 10) }, select: { id: true, name: true, role: true } });
    await audit(req, 'CREATE', 'User', u.id, { role: b.role });
    return u;
  });

}
