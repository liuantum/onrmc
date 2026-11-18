import type { FastifyInstance } from 'fastify';
import { prisma, num } from '../lib/prisma.js';
import { requireRole, tid } from '../lib/auth.js';
import { profitAndLoss } from './accounts.js';

const range = (q: Record<string, string | undefined>) => {
  const to = q.to ? new Date(new Date(q.to).getTime() + 864e5 - 1) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getFullYear(), to.getMonth(), 1);
  return { from, to };
};

export default async function (app: FastifyInstance) {
  /** Operational dashboard — no cost or margin data. Managers and the owner app use it. */
  app.get('/dashboard', { preHandler: requireRole('MANAGER', 'ACCOUNTANT') }, async (req) => {
    const t = tid(req);
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const [produced, delivered, sales, collections, receivable, activeTrips, pendingOrders, lowStock] = await Promise.all([
      prisma.batch.aggregate({ where: { tenantId: t, batchedAt: { gte: start }, cancelledAt: null }, _sum: { quantityM3: true } }),
      prisma.challan.aggregate({ where: { tenantId: t, deliveredAt: { gte: start } }, _sum: { quantityM3: true }, _count: true }),
      prisma.invoice.aggregate({ where: { tenantId: t, issueDate: { gte: start }, status: { not: 'CANCELLED' } }, _sum: { total: true } }),
      prisma.payment.aggregate({ where: { tenantId: t, receivedAt: { gte: start } }, _sum: { amount: true } }),
      prisma.invoice.findMany({ where: { tenantId: t, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } }, select: { total: true, paid: true, noteAdj: true } }),
      prisma.challan.count({ where: { tenantId: t, status: { in: ['LOADED', 'IN_TRANSIT', 'AT_SITE', 'UNLOADING'] } } }),
      prisma.order.count({ where: { tenantId: t, status: { in: ['CONFIRMED', 'IN_PROGRESS'] } } }),
      prisma.$queryRaw<{ name: string; quantity: number; reorder: number }[]>`
        SELECT m.name, COALESCE(SUM(s.quantity),0)::float AS quantity, m."reorderLevel"::float AS reorder
        FROM "Material" m LEFT JOIN "Stock" s ON s."materialId" = m.id
        WHERE m."tenantId" = ${t} GROUP BY m.id HAVING COALESCE(SUM(s.quantity),0) <= m."reorderLevel"`,
    ]);
    return {
      today: {
        producedM3: num(produced._sum.quantityM3), deliveredM3: num(delivered._sum.quantityM3), trips: delivered._count,
        sales: num(sales._sum.total), collections: num(collections._sum.amount),
      },
      receivable: receivable.reduce((s, i) => s + num(i.total) + num(i.noteAdj) - num(i.paid), 0),
      activeTrips, pendingOrders, lowStock,
    };
  });

  /**
   * OWNER ONLY — margin analytics (cost = materials consumed + challan diesel, both from the ledger). Totals come from the books (same function as the P&L), so
   * revenue, cost of materials, gross margin and net agree with Accounts → Profit & loss for
   * the same period. The by-customer / by-grade split attributes the same journals:
   * sales from invoice postings (and cancellations), material cost from batch postings.
   */
  app.get('/margin', { preHandler: requireRole('OWNER') }, async (req) => {
    const t = tid(req);
    const { from, to } = range(req.query as Record<string, string>);
    const pl = await profitAndLoss(t, from, to);

    type Agg = { key: string; m3: number; revenue: number; materialCost: number; diesel: number };
    const blank = (key: string): Agg => ({ key, m3: 0, revenue: 0, materialCost: 0, diesel: 0 });
    const byCustomer = new Map<string, Agg>(), byGrade = new Map<string, Agg>();
    const get = (m: Map<string, Agg>, k: string) => m.get(k) ?? m.set(k, blank(k)).get(k)!;
    const OTHER = 'Pumping, other charges & round-off';

    const journals = await prisma.journal.findMany({
      where: { tenantId: t, date: { gte: from, lte: to }, sourceType: { in: ['INVOICE', 'INVOICE_CANCEL', 'BATCH', 'BATCH_CANCEL', 'CHALLAN_DIESEL', 'CHALLAN_DIESEL_REV', 'CREDIT_NOTE', 'DEBIT_NOTE', 'CREDIT_NOTE_CANCEL', 'DEBIT_NOTE_CANCEL'] } },
      include: { entries: { include: { account: { select: { code: true } } } } },
    });
    const invIds = journals.filter((j) => j.sourceType.startsWith('INVOICE')).map((j) => j.sourceId!);
    const batchIds = journals.filter((j) => j.sourceType.startsWith('BATCH')).map((j) => j.sourceId!);
    const challanIds = journals.filter((j) => j.sourceType.startsWith('CHALLAN_DIESEL')).map((j) => j.sourceId!);
    const noteIds = journals.filter((j) => j.sourceType.includes('_NOTE')).map((j) => j.sourceId!);
    const [challans, notes] = await Promise.all([
      prisma.challan.findMany({ where: { id: { in: challanIds } }, select: { id: true, order: { select: { customer: { select: { name: true } }, mixDesign: { select: { grade: true } } } } } }),
      prisma.creditDebitNote.findMany({ where: { id: { in: noteIds } }, include: { customer: { select: { name: true } }, lines: { include: { invoiceLine: { include: { challan: { select: { order: { select: { mixDesign: { select: { grade: true } } } } } } } } } } } }),
    ]);
    const [invoices, batches] = await Promise.all([
      prisma.invoice.findMany({ where: { id: { in: invIds } }, include: { customer: { select: { name: true } }, lines: { include: { challan: { select: { order: { select: { mixDesign: { select: { grade: true } } } } } } } } } }),
      prisma.batch.findMany({ where: { id: { in: batchIds } }, include: { order: { select: { customer: { select: { name: true } }, mixDesign: { select: { grade: true } } } } } }),
    ]);
    for (const j of journals) {
      const sign = j.sourceType.endsWith('_CANCEL') || j.sourceType.endsWith('_REV') ? -1 : 1;
      if (j.sourceType.startsWith('CHALLAN_DIESEL')) {
        const ch = challans.find((x) => x.id === j.sourceId);
        if (!ch) continue;
        const d = j.entries.filter((e) => e.account.code === '5100').reduce((s2, e) => s2 + num(e.debit) - num(e.credit), 0);
        get(byCustomer, ch.order.customer.name).diesel += d;
        get(byGrade, ch.order.mixDesign.grade).diesel += d;
      } else if (j.sourceType.includes('_NOTE')) {
        // credit note reduces sales, debit note adds
        const n = notes.find((x) => x.id === j.sourceId);
        if (!n) continue;
        const ns = sign * (n.type === 'CREDIT' ? -1 : 1);
        get(byCustomer, n.customer.name).revenue += ns * (num(n.taxable) + num(n.roundOff));
        get(byGrade, OTHER).revenue += ns * num(n.roundOff);
        for (const l of n.lines) {
          const concrete = l.hsn.startsWith('3824');
          const grade = l.invoiceLine?.challan?.order.mixDesign.grade ?? /Concrete (\S+)/.exec(l.description)?.[1] ?? 'Concrete';
          get(byGrade, concrete ? grade : OTHER).revenue += ns * num(l.taxable);
          // only returned / short-supplied quantity changes billed m³
          if (concrete && n.quantityBased) { get(byGrade, grade).m3 += ns * num(l.quantity); get(byCustomer, n.customer.name).m3 += ns * num(l.quantity); }
        }
      } else if (j.sourceType.startsWith('INVOICE')) {
        const inv = invoices.find((i) => i.id === j.sourceId);
        if (!inv) continue;
        const c = get(byCustomer, inv.customer.name);
        c.revenue += sign * (num(inv.taxable) + num(inv.roundOff));
        get(byGrade, OTHER).revenue += sign * num(inv.roundOff);
        for (const l of inv.lines) {
          const concrete = l.hsn.startsWith('3824');
          // cancelled invoices release their challans, so fall back to the grade in the line description
          const grade = l.challan?.order.mixDesign.grade ?? /Concrete (\S+)/.exec(l.description)?.[1] ?? 'Concrete';
          const g = get(byGrade, concrete ? grade : OTHER);
          g.revenue += sign * num(l.taxable);
          if (concrete) { g.m3 += sign * num(l.quantity); c.m3 += sign * num(l.quantity); }
        }
      } else {
        const b = batches.find((x) => x.id === j.sourceId);
        if (!b) continue;
        const cost = j.entries.filter((e) => e.account.code === '5000').reduce((s2, e) => s2 + num(e.debit) - num(e.credit), 0);
        get(byCustomer, b.order.customer.name).materialCost += cost;
        get(byGrade, b.order.mixDesign.grade).materialCost += cost;
      }
    }

    const r2 = (n: number) => Math.round(n * 100) / 100;
    const fin = (a: Agg) => {
      const revenue = r2(a.revenue), materialCost = r2(a.materialCost), diesel = r2(a.diesel), cost = r2(materialCost + diesel), margin = r2(revenue - cost);
      return { ...a, revenue, materialCost, diesel, cost, margin, marginPct: revenue ? (margin / revenue) * 100 : 0, costPerM3: a.m3 ? cost / a.m3 : 0, revenuePerM3: a.m3 ? revenue / a.m3 : 0 };
    };
    // Anything in the P&L not tied to an invoice or batch (manual journals) — keeps the split adding up to the totals.
    for (const m of [byCustomer, byGrade]) {
      const rev = [...m.values()].reduce((s2, a) => s2 + a.revenue, 0), mat = [...m.values()].reduce((s2, a) => s2 + a.materialCost, 0);
      const dsl = [...m.values()].reduce((s2, a) => s2 + a.diesel, 0);
      if (Math.abs(pl.income - rev) >= 0.01 || Math.abs(pl.materials - mat) >= 0.01 || Math.abs(pl.directExpenses - dsl) >= 0.01) {
        const o = get(m, 'Manual / other entries'); o.revenue += pl.income - rev; o.materialCost += pl.materials - mat; o.diesel += pl.directExpenses - dsl;
      }
    }
    const billedM3 = [...byGrade.values()].reduce((s2, a) => s2 + a.m3, 0);
    const totals = fin({ key: 'total', m3: billedM3, revenue: pl.income, materialCost: pl.materials, diesel: pl.directExpenses });

    const consumption = await prisma.batchConsumption.findMany({
      where: { batch: { tenantId: t, batchedAt: { gte: from, lte: to }, cancelledAt: null } },
      select: { designQty: true, actualQty: true, material: { select: { name: true, avgCost: true } } },
    });
    const wastage = new Map<string, { material: string; design: number; actual: number; extraCost: number }>();
    for (const x of consumption) {
      const w = wastage.get(x.material.name) ?? { material: x.material.name, design: 0, actual: 0, extraCost: 0 };
      w.design += num(x.designQty); w.actual += num(x.actualQty);
      w.extraCost += (num(x.actualQty) - num(x.designQty)) * num(x.material.avgCost);
      wastage.set(x.material.name, w);
    }
    return {
      from, to, totals, overhead: pl.otherExpenses, netAfterOverhead: pl.net,
      pl: { income: pl.income, materials: pl.materials, directExpenses: pl.directExpenses, grossProfit: pl.grossProfit, otherExpenses: pl.otherExpenses, net: pl.net },
      byCustomer: [...byCustomer.values()].map(fin).sort((a, b) => b.margin - a.margin),
      byGrade: [...byGrade.values()].map(fin).sort((a, b) => b.m3 - a.m3),
      wastage: [...wastage.values()].sort((a, b) => b.extraCost - a.extraCost),
    };
  });
}
