import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireRole } from '../lib/auth.js';
import { SYSTEM_ACCOUNTS } from '../lib/ledger.js';
import { audit } from '../lib/audit.js';

/** Super admin: plans, tenants (plant owners), subscriptions. */
export default async function (app: FastifyInstance) {
  app.addHook('preHandler', requireRole('SUPER_ADMIN'));

  app.get('/stats', async () => {
    const [tenants, active, trial, mrr] = await Promise.all([
      prisma.tenant.count(),
      prisma.subscription.count({ where: { status: 'ACTIVE', endsAt: { gt: new Date() } } }),
      prisma.subscription.count({ where: { status: 'TRIAL', endsAt: { gt: new Date() } } }),
      prisma.subscription.findMany({ where: { status: 'ACTIVE', endsAt: { gt: new Date() } }, include: { plan: true } }),
    ]);
    const monthly = mrr.reduce((s, x) => s + Number(x.billingCycle === 'YEARLY' ? x.plan.priceYearly.div(12) : x.plan.priceMonthly), 0);
    return { tenants, active, trial, mrr: Math.round(monthly) };
  });

  const planSchema = z.object({
    name: z.string(), priceMonthly: z.number(), priceYearly: z.number(),
    maxPlants: z.number().int(), maxUsers: z.number().int(), maxVehicles: z.number().int(),
    features: z.array(z.string()).default([]), active: z.boolean().default(true),
  });
  app.get('/plans', async () => prisma.plan.findMany({ orderBy: { priceMonthly: 'asc' } }));
  app.post('/plans', async (req) => prisma.plan.create({ data: planSchema.parse(req.body) }));
  app.put('/plans/:id', async (req) => prisma.plan.update({ where: { id: (req.params as { id: string }).id }, data: planSchema.partial().parse(req.body) }));

  app.get('/tenants', async () =>
    prisma.tenant.findMany({
      orderBy: { createdAt: 'desc' },
      include: { subscriptions: { orderBy: { endsAt: 'desc' }, take: 1, include: { plan: true } }, _count: { select: { users: true, plants: true, vehicles: true } } },
    }));

  /** Onboard a plant owner: tenant + owner login + default plant + chart of accounts + subscription. */
  app.post('/tenants', async (req) => {
    const b = z.object({
      name: z.string(), gstin: z.string().optional(), stateCode: z.string().length(2),
      ownerName: z.string(), ownerPhone: z.string(), ownerPassword: z.string().min(8),
      planId: z.string(), trialDays: z.number().int().default(14),
    }).parse(req.body);
    const tenant = await prisma.$transaction(async (tx) => {
      const t = await tx.tenant.create({ data: { name: b.name, gstin: b.gstin, stateCode: b.stateCode } });
      await tx.user.create({ data: { tenantId: t.id, name: b.ownerName, phone: b.ownerPhone, role: 'OWNER', passwordHash: await bcrypt.hash(b.ownerPassword, 10) } });
      await tx.plant.create({ data: { tenantId: t.id, name: 'Main Plant' } });
      await tx.account.createMany({ data: SYSTEM_ACCOUNTS.map((a) => ({ ...a, tenantId: t.id, system: true })) });
      await tx.subscription.create({ data: { tenantId: t.id, planId: b.planId, status: 'TRIAL', endsAt: new Date(Date.now() + b.trialDays * 864e5) } });
      return t;
    });
    await audit(req, 'CREATE', 'Tenant', tenant.id, { name: b.name });
    return tenant;
  });

  app.post('/tenants/:id/subscription', async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ planId: z.string(), status: z.enum(['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED']), billingCycle: z.enum(['MONTHLY', 'YEARLY']), months: z.number().int().min(0) }).parse(req.body);
    const sub = await prisma.subscription.create({ data: { tenantId: id, planId: b.planId, status: b.status, billingCycle: b.billingCycle, endsAt: new Date(Date.now() + b.months * 30 * 864e5) } });
    await audit(req, 'SUBSCRIPTION', 'Tenant', id, b);
    return sub;
  });

  app.post('/tenants/:id/active', async (req) => {
    const { id } = req.params as { id: string };
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    return prisma.tenant.update({ where: { id }, data: { active } });
  });
}
