import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, num } from '../lib/prisma.js';
import { requireRole, tid } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { bad, notFound } from '../lib/errors.js';
import { nextNumber } from '../lib/numbering.js';

const r2 = (n: number) => Math.round(n * 100) / 100;
export const fckOf = (grade: string) => { const m = /M\s*(\d+(?:\.\d+)?)/i.exec(grade); return m ? Number(m[1]) : null; };
export const strength = (loadKn: number, sideMm: number) => r2((loadKn * 1000) / (sideMm * sideMm));

/**
 * Acceptance per IS 456:2000 (Amendment 4), clause 16 / Table 11, for 28-day results:
 * - each sample (mean of its cubes) ≥ fck − 3 (M15) or fck − 4 (M20 and above);
 * - mean of 4 consecutive non-overlapping samples of a grade ≥ fck + 3 (M15) or fck + 4 (M20+)
 *   (the early-stage rule, used until the plant has 30 samples to set a standard deviation).
 * Individual cubes more than ±15 % from their sample mean make the sample invalid (IS 456 cl. 15.4).
 * 7-day results are indicative only: about 65 % of fck is expected.
 */
export function evaluate(fck: number, cubes: number[], ageDays: number) {
  if (!cubes.length) return null;
  const mean = r2(cubes.reduce((a, b) => a + b, 0) / cubes.length);
  const spreadOk = cubes.every((c) => Math.abs(c - mean) <= 0.15 * mean);
  const low = fck <= 15 ? 3 : 4;
  if (ageDays >= 28) {
    const minSample = fck - low;
    return { mean, spreadOk, kind: 'ACCEPTANCE' as const, minSample, pass: spreadOk && mean >= minSample, ratio: r2(mean / fck) };
  }
  const expect = r2(fck * (ageDays >= 14 ? 0.9 : ageDays >= 7 ? 0.65 : 0.4));
  return { mean, spreadOk, kind: 'INDICATIVE' as const, expected: expect, pass: spreadOk && mean >= expect, ratio: r2(mean / fck) };
}

export default async function (app: FastifyInstance) {
  const view = { preHandler: requireRole('MANAGER', 'BATCHING', 'DISPATCH', 'SALES') };
  const edit = { preHandler: requireRole('MANAGER', 'BATCHING') };

  app.get('/qc/cube-sets', view, async (req) => {
    const q = z.object({ grade: z.string().optional(), pending: z.coerce.boolean().optional() }).parse(req.query);
    const sets = await prisma.cubeSet.findMany({
      where: { tenantId: tid(req), ...(q.grade ? { grade: q.grade } : {}) }, orderBy: { sampledAt: 'desc' }, take: 300,
      include: { results: { orderBy: [{ ageDays: 'asc' }, { cubeNo: 'asc' }] }, batch: { select: { number: true, quantityM3: true, order: { select: { number: true, customer: { select: { name: true } }, site: { select: { name: true } } } }, challan: { select: { number: true } } } } },
    });
    const now = Date.now();
    const out = sets.map((s) => {
      const ages = [...new Set(s.results.map((r) => r.ageDays))];
      const byAge = ages.map((a) => ({ ageDays: a, cubes: s.results.filter((r) => r.ageDays === a).map((r) => num(r.strengthMpa)), ...evaluate(num(s.fck), s.results.filter((r) => r.ageDays === a).map((r) => num(r.strengthMpa)), a)! }));
      const has28 = ages.some((a) => a >= 28);
      const age = Math.floor((now - s.sampledAt.getTime()) / 864e5);
      const due = !has28 && age >= 28 ? 28 : !ages.includes(7) && !has28 && age >= 7 ? 7 : null;
      return { ...s, byAge, ageNow: age, testDue: due };
    });
    return q.pending ? out.filter((s) => s.testDue) : out;
  });

  /** Grade-wise IS 456 group check: last 4 non-overlapping 28-day samples. */
  app.get('/qc/summary', view, async (req) => {
    const sets = await prisma.cubeSet.findMany({ where: { tenantId: tid(req) }, orderBy: { sampledAt: 'asc' }, include: { results: { where: { ageDays: { gte: 28 } } } } });
    const grades = new Map<string, { fck: number; samples: { number: string; sampledAt: Date; mean: number; pass: boolean }[] }>();
    for (const s of sets) {
      const e = evaluate(num(s.fck), s.results.map((r) => num(r.strengthMpa)), 28);
      if (!e) continue;
      const g = grades.get(s.grade) ?? { fck: num(s.fck), samples: [] };
      g.samples.push({ number: s.number, sampledAt: s.sampledAt, mean: e.mean, pass: e.pass });
      grades.set(s.grade, g);
    }
    return [...grades.entries()].map(([grade, g]) => {
      const n = g.samples.length, means = g.samples.map((x) => x.mean);
      const avg = r2(means.reduce((a, b) => a + b, 0) / n);
      const sd = n > 1 ? r2(Math.sqrt(means.reduce((a, b) => a + (b - avg) ** 2, 0) / (n - 1))) : null;
      const last4 = means.slice(-4);
      const groupMean = last4.length === 4 ? r2(last4.reduce((a, b) => a + b, 0) / 4) : null;
      const groupMin = r2(g.fck + (g.fck <= 15 ? 3 : 4));
      return { grade, fck: g.fck, samples: n, failedSamples: g.samples.filter((x) => !x.pass).length, average: avg, stdDev: sd, last4GroupMean: groupMean, groupRequired: groupMin, groupPass: groupMean == null ? null : groupMean >= groupMin };
    });
  });

  app.post('/qc/cube-sets', edit, async (req) => {
    const b = z.object({
      batchId: z.string(), sampledAt: z.coerce.date().optional(), slumpMm: z.number().int().min(0).max(300).nullish(),
      tempC: z.number().min(0).max(60).nullish(), cubeSizeMm: z.union([z.literal(150), z.literal(100)]).default(150), notes: z.string().max(300).nullish(),
    }).parse(req.body);
    const t = tid(req);
    const batch = await prisma.batch.findFirst({ where: { id: b.batchId, tenantId: t }, include: { order: { include: { mixDesign: true } } } });
    if (!batch) throw notFound('Batch not found');
    if (batch.cancelledAt) throw bad('This batch was cancelled');
    const fck = fckOf(batch.order.mixDesign.grade);
    if (!fck) throw bad(`Can't read the characteristic strength from grade "${batch.order.mixDesign.grade}" (expected like M25)`);
    const set = await prisma.$transaction(async (tx) => tx.cubeSet.create({ data: {
      tenantId: t, number: await nextNumber(tx, t, 'QC'), batchId: batch.id, grade: batch.order.mixDesign.grade.toUpperCase().replace(/\s+/g, ''), fck,
      sampledAt: b.sampledAt ?? batch.batchedAt, slumpMm: b.slumpMm, tempC: b.tempC, cubeSizeMm: b.cubeSizeMm, notes: b.notes, sampledById: req.user.sub,
    } }));
    await audit(req, 'CREATE', 'CubeSet', set.id, { batch: batch.number, ...b });
    return set;
  });

  /** Record the crushing results for one age (e.g. 3 cubes at 28 days). Load in kN, or strength directly. */
  app.post('/qc/cube-sets/:id/results', edit, async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({
      ageDays: z.number().int().min(1).max(365), testedAt: z.coerce.date().optional(),
      cubes: z.array(z.object({ loadKn: z.number().positive().max(3000).optional(), strengthMpa: z.number().positive().max(150).optional(), weightKg: z.number().positive().max(20).optional(), remarks: z.string().max(200).optional() })
        .refine((c) => c.loadKn || c.strengthMpa, 'Enter the load (kN) or the strength')).min(1).max(6),
    }).parse(req.body);
    const set = await prisma.cubeSet.findFirst({ where: { id, tenantId: tid(req) }, include: { results: true } });
    if (!set) throw notFound();
    if (set.results.some((r) => r.ageDays === b.ageDays)) throw bad(`${b.ageDays}-day results are already recorded for this set`);
    const testedAt = b.testedAt ?? new Date();
    if (testedAt < set.sampledAt) throw bad('Test date is before the sampling date');
    const area = set.cubeSizeMm * set.cubeSizeMm;
    const rows = b.cubes.map((c, i) => {
      const load = c.loadKn ?? r2((c.strengthMpa! * area) / 1000);
      return { cubeSetId: id, ageDays: b.ageDays, testedAt, cubeNo: i + 1, loadKn: load, strengthMpa: c.loadKn ? strength(c.loadKn, set.cubeSizeMm) : c.strengthMpa!, weightKg: c.weightKg, remarks: c.remarks, testedById: req.user.sub };
    });
    await prisma.cubeResult.createMany({ data: rows });
    const e = evaluate(num(set.fck), rows.map((r) => r.strengthMpa), b.ageDays);
    await audit(req, 'QC_RESULT', 'CubeSet', id, { ageDays: b.ageDays, strengths: rows.map((r) => r.strengthMpa), mean: e?.mean, pass: e?.pass });
    return { ok: true, ...e };
  });
}
