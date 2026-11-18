import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, num } from '../lib/prisma.js';
import { requireRole, tid } from '../lib/auth.js';
import { accountId, post } from '../lib/ledger.js';
import { audit } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';

const range = (q: Record<string, string | undefined>) => ({
  // default: start of the Indian financial year (1 April)
  from: q.from ? new Date(q.from) : new Date(new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1, 3, 1),
  to: q.to ? new Date(new Date(q.to).getTime() + 864e5 - 1) : new Date(),
});

/**
 * Profit & loss in the usual trading format: sales, less cost of materials consumed (5000) and other
 * direct expenses (diesel / fuel) = gross profit, less indirect expenses = net profit. The owner margin view uses this same function for its totals.
 */
export async function profitAndLoss(tenantId: string, from: Date, to: Date) {
  const sums = await prisma.journalEntry.groupBy({ by: ['accountId'], where: { journal: { tenantId, date: { gte: from, lte: to } }, account: { type: { in: ['INCOME', 'EXPENSE'] } } }, _sum: { debit: true, credit: true } });
  const accs = await prisma.account.findMany({ where: { id: { in: sums.map((x) => x.accountId) } } });
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const rows = sums.map((x) => {
    const a = accs.find((y) => y.id === x.accountId)!;
    return { code: a.code, name: a.name, type: a.type, group: a.group, amount: r2(a.type === 'INCOME' ? num(x._sum.credit) - num(x._sum.debit) : num(x._sum.debit) - num(x._sum.credit)) };
  }).filter((r) => r.amount !== 0).sort((a, b) => a.code.localeCompare(b.code));
  const sales = rows.filter((r) => r.type === 'INCOME');
  const materials = rows.find((r) => r.code === '5000')?.amount ?? 0;
  // Direct expenses (diesel / fuel, …) sit above gross profit, like a trading account; the rest are overheads.
  const direct = rows.filter((r) => r.type === 'EXPENSE' && r.code !== '5000' && r.group === 'Direct Expenses');
  const expenses = rows.filter((r) => r.type === 'EXPENSE' && r.code !== '5000' && r.group !== 'Direct Expenses');
  const income = r2(sales.reduce((a, r) => a + r.amount, 0));
  const directExpenses = r2(direct.reduce((a, r) => a + r.amount, 0));
  const otherExpenses = r2(expenses.reduce((a, r) => a + r.amount, 0));
  const grossProfit = r2(income - materials - directExpenses);
  const net = r2(grossProfit - otherExpenses);
  return { from, to, sales, income, materials, direct, directExpenses, grossProfit, expenses, otherExpenses, net, rows, expense: r2(materials + directExpenses + otherExpenses) };
}

export default async function (app: FastifyInstance) {
  app.addHook('preHandler', requireRole('ACCOUNTANT', 'MANAGER'));

  /** Chart of accounts with closing balances (Dr positive). */
  app.get('/', async (req) => {
    const t = tid(req);
    const [accounts, sums] = await Promise.all([
      prisma.account.findMany({ where: { tenantId: t }, orderBy: { code: 'asc' } }),
      prisma.journalEntry.groupBy({ by: ['accountId'], where: { journal: { tenantId: t } }, _sum: { debit: true, credit: true } }),
    ]);
    const m = new Map(sums.map((s) => [s.accountId, num(s._sum.debit) - num(s._sum.credit)]));
    return accounts.map((a) => ({ ...a, balance: Math.round((m.get(a.id) ?? 0) * 100) / 100 }));
  });

  app.post('/', async (req) => {
    const b = z.object({ code: z.string(), name: z.string(), type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']), group: z.string() }).parse(req.body);
    return prisma.account.create({ data: { ...b, tenantId: tid(req) } });
  });

  /** Ledger statement with opening balance and running balance. */
  app.get('/:id/ledger', async (req) => {
    const t = tid(req);
    const { id } = req.params as { id: string };
    const { from, to } = range(req.query as Record<string, string>);
    const acc = await prisma.account.findFirst({ where: { id, tenantId: t } });
    if (!acc) throw notFound();
    const op = await prisma.journalEntry.aggregate({ where: { accountId: id, journal: { date: { lt: from } } }, _sum: { debit: true, credit: true } });
    let bal = num(op._sum.debit) - num(op._sum.credit);
    const opening = bal;
    const entries = await prisma.journalEntry.findMany({ where: { accountId: id, journal: { date: { gte: from, lte: to } } }, include: { journal: true }, orderBy: { journal: { date: 'asc' } } });
    const rows = entries.map((e) => {
      bal += num(e.debit) - num(e.credit);
      return { date: e.journal.date, narration: e.journal.narration, sourceType: e.journal.sourceType, sourceId: e.journal.sourceId, debit: num(e.debit), credit: num(e.credit), balance: Math.round(bal * 100) / 100 };
    });
    return { account: acc, opening, closing: bal, rows };
  });

  /** Receivables ageing per customer. */
  app.get('/receivables', async (req) => {
    const t = tid(req);
    const open = await prisma.invoice.findMany({ where: { tenantId: t, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } }, include: { customer: { select: { id: true, name: true, phone: true, creditLimit: true } } } });
    const now = Date.now();
    const by = new Map<string, { customer: (typeof open)[0]['customer']; current: number; d30: number; d60: number; d90: number; over90: number; total: number }>();
    for (const inv of open) {
      const due = num(inv.total) + num(inv.noteAdj) - num(inv.paid);
      const age = Math.floor((now - inv.dueDate.getTime()) / 864e5);
      const r = by.get(inv.customerId) ?? { customer: inv.customer, current: 0, d30: 0, d60: 0, d90: 0, over90: 0, total: 0 };
      if (age <= 0) r.current += due; else if (age <= 30) r.d30 += due; else if (age <= 60) r.d60 += due; else if (age <= 90) r.d90 += due; else r.over90 += due;
      r.total += due;
      by.set(inv.customerId, r);
    }
    // credit notes not absorbed by their invoice are customer credit — shown against the balance
    const unapplied = await prisma.creditDebitNote.findMany({ where: { tenantId: t, type: 'CREDIT', status: 'ISSUED' }, select: { customerId: true, total: true, applied: true, customer: { select: { id: true, name: true, phone: true, creditLimit: true } } } });
    for (const n of unapplied) {
      const left = num(n.total) - num(n.applied);
      if (left <= 0.001) continue;
      const r = by.get(n.customerId) ?? { customer: n.customer, current: 0, d30: 0, d60: 0, d90: 0, over90: 0, total: 0 };
      (r as typeof r & { credit?: number }).credit = ((r as typeof r & { credit?: number }).credit ?? 0) + left;
      r.total -= left;
      by.set(n.customerId, r);
    }
    return [...by.values()].sort((a, b) => b.total - a.total);
  });

  app.get('/trial-balance', async (req) => {
    const t = tid(req);
    const { to } = range(req.query as Record<string, string>);
    const sums = await prisma.journalEntry.groupBy({ by: ['accountId'], where: { journal: { tenantId: t, date: { lte: to } } }, _sum: { debit: true, credit: true } });
    const accs = await prisma.account.findMany({ where: { tenantId: t } });
    const rows = accs.map((a) => {
      const s = sums.find((x) => x.accountId === a.id);
      const bal = num(s?._sum.debit) - num(s?._sum.credit);
      return { code: a.code, name: a.name, group: a.group, debit: bal > 0 ? bal : 0, credit: bal < 0 ? -bal : 0 };
    }).filter((r) => r.debit || r.credit);
    return { rows, totalDebit: rows.reduce((s, r) => s + r.debit, 0), totalCredit: rows.reduce((s, r) => s + r.credit, 0) };
  });

  app.get('/profit-loss', async (req) => {
    const { from, to } = range(req.query as Record<string, string>);
    return profitAndLoss(tid(req), from, to);
  });

  /** Balance sheet as at `to`. Inventory is shown next to the stock valuation it should equal. */
  app.get('/balance-sheet', async (req) => {
    const t = tid(req);
    const { to } = range(req.query as Record<string, string>);
    const [sums, accs] = await Promise.all([
      prisma.journalEntry.groupBy({ by: ['accountId'], where: { journal: { tenantId: t, date: { lte: to } } }, _sum: { debit: true, credit: true } }),
      prisma.account.findMany({ where: { tenantId: t }, orderBy: { code: 'asc' } }),
    ]);
    const bal = new Map(sums.map((x) => [x.accountId, num(x._sum.debit) - num(x._sum.credit)]));
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const side = (type: string, sign: 1 | -1) => accs.filter((a) => a.type === type)
      .map((a) => ({ code: a.code, name: a.name, group: a.group, amount: r2(sign * (bal.get(a.id) ?? 0)) })).filter((r) => r.amount !== 0);
    const assets = side('ASSET', 1), liabilities = side('LIABILITY', -1), equity = side('EQUITY', -1);
    // profit to date not yet closed to capital
    const retained = r2(accs.filter((a) => a.type === 'INCOME' || a.type === 'EXPENSE').reduce((s2, a) => s2 - (bal.get(a.id) ?? 0), 0));
    const total = (rows: { amount: number }[]) => r2(rows.reduce((s2, r) => s2 + r.amount, 0));
    const inventoryLedger = r2(bal.get(accs.find((a) => a.code === '1400')?.id ?? '') ?? 0);
    const val = await prisma.$queryRaw<{ v: number | null }[]>`
      SELECT SUM(s.quantity * m."avgCost")::float AS v FROM "Stock" s JOIN "Material" m ON m.id = s."materialId" WHERE s."tenantId" = ${t}`;
    const stockValuation = r2(val[0]?.v ?? 0);
    return {
      to, assets, liabilities, equity, profitToDate: retained,
      totalAssets: total(assets), totalLiabilitiesAndEquity: r2(total(liabilities) + total(equity) + retained),
      inventory: { ledger: inventoryLedger, stockValuation, difference: r2(inventoryLedger - stockValuation), asOfToday: true },
    };
  });

  /** GST summary (GSTR-1 / 3B helper) from issued tax invoices. */
  app.get('/gst-summary', async (req) => {
    const t = tid(req);
    const { from, to } = range(req.query as Record<string, string>);
    const inv = await prisma.invoice.findMany({ where: { tenantId: t, type: 'TAX_INVOICE', status: { not: 'CANCELLED' }, issueDate: { gte: from, lte: to } }, include: { customer: { select: { name: true, gstin: true } } }, orderBy: { issueDate: 'asc' } });
    // credit / debit notes against tax invoices (GSTR-1 table 9B): credit notes reduce, debit notes add
    const notes = await prisma.creditDebitNote.findMany({ where: { tenantId: t, status: 'ISSUED', invoice: { type: 'TAX_INVOICE' }, issueDate: { gte: from, lte: to } }, include: { customer: { select: { name: true, gstin: true } }, invoice: { select: { number: true } } }, orderBy: { issueDate: 'asc' } });
    type K = 'taxable' | 'cgst' | 'sgst' | 'igst' | 'total';
    const sign = (n: { type: string }) => (n.type === 'CREDIT' ? -1 : 1);
    const sum = (k: K) => Math.round((inv.reduce((s2, i) => s2 + num(i[k]), 0) + notes.reduce((s2, n) => s2 + sign(n) * num(n[k]), 0)) * 100) / 100;
    // Input tax credit from purchase bills (GSTR-3B 4A), less supplier debit notes; RCM shown separately (3.1(d) + 4A(3)).
    const bills = await prisma.purchaseBill.findMany({ where: { tenantId: t, status: { not: 'CANCELLED' }, billDate: { gte: from, lte: to } }, include: { supplier: { select: { name: true, gstin: true } } }, orderBy: { billDate: 'asc' } });
    const sdn = await prisma.supplierDebitNote.findMany({ where: { tenantId: t, status: 'ISSUED', issueDate: { gte: from, lte: to } }, include: { bill: { select: { rcm: true } } } });
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const itcOf = (rcm: boolean) => {
      const b2 = bills.filter((b) => b.rcm === rcm), d2 = sdn.filter((d) => d.bill.rcm === rcm);
      const k = (key: 'taxable' | 'cgst' | 'sgst' | 'igst') => r2(b2.reduce((s2, b) => s2 + num(b[key]), 0) - d2.reduce((s2, d) => s2 + num(d[key]), 0));
      return { bills: b2.length, debitNotes: d2.length, taxable: k('taxable'), cgst: k('cgst'), sgst: k('sgst'), igst: k('igst') };
    };
    const itc = { regular: itcOf(false), reverseCharge: itcOf(true),
      bills: bills.map((b) => ({ number: b.number, supplierBillNo: b.supplierBillNo, date: b.billDate, supplier: b.supplier.name, gstin: b.supplier.gstin, rcm: b.rcm, taxable: num(b.taxable), cgst: num(b.cgst), sgst: num(b.sgst), igst: num(b.igst) })) };
    return {
      itc,
      b2b: inv.filter((i) => i.customer.gstin).length, b2c: inv.filter((i) => !i.customer.gstin).length,
      creditNotes: notes.filter((n) => n.type === 'CREDIT').length, debitNotes: notes.filter((n) => n.type === 'DEBIT').length,
      taxable: sum('taxable'), cgst: sum('cgst'), sgst: sum('sgst'), igst: sum('igst'), total: sum('total'),
      invoices: [
        ...inv.map((i) => ({ docType: 'INV', number: i.number, date: i.issueDate, customer: i.customer.name, gstin: i.customer.gstin, pos: i.placeOfSupply, against: null as string | null, taxable: num(i.taxable), cgst: num(i.cgst), sgst: num(i.sgst), igst: num(i.igst), total: num(i.total) })),
        ...notes.map((n) => ({ docType: n.type === 'CREDIT' ? 'CRN' : 'DBN', number: n.number, date: n.issueDate, customer: n.customer.name, gstin: n.customer.gstin, pos: n.placeOfSupply, against: n.invoice.number, taxable: sign(n) * num(n.taxable), cgst: sign(n) * num(n.cgst), sgst: sign(n) * num(n.sgst), igst: sign(n) * num(n.igst), total: sign(n) * num(n.total) })),
      ].sort((a2, b2) => +a2.date - +b2.date),
    };
  });

  /** Simple expense voucher: Dr expense, Cr cash/bank (or supplier). */
  app.post('/expenses', async (req) => {
    const b = z.object({ expenseAccountId: z.string(), paidFrom: z.enum(['CASH', 'BANK']), amount: z.number().positive(), narration: z.string(), date: z.coerce.date().optional() }).parse(req.body);
    const t = tid(req);
    const j = await prisma.$transaction(async (tx) => post(tx, t, b.narration, 'EXPENSE', null, [
      { accountId: b.expenseAccountId, debit: b.amount },
      { accountId: await accountId(tx, t, b.paidFrom === 'CASH' ? '1100' : '1200'), credit: b.amount },
    ], b.date));
    await audit(req, 'CREATE', 'Expense', j.id, b);
    return j;
  });

  /** Manual journal voucher (must balance). */
  app.post('/journals', async (req) => {
    const b = z.object({ narration: z.string(), date: z.coerce.date().optional(), legs: z.array(z.object({ accountId: z.string(), debit: z.number().default(0), credit: z.number().default(0) })).min(2) }).parse(req.body);
    const t = tid(req);
    const n = await prisma.account.count({ where: { tenantId: t, id: { in: b.legs.map((l) => l.accountId) } } });
    if (n !== new Set(b.legs.map((l) => l.accountId)).size) throw notFound('Account not found');
    const j = await prisma.$transaction((tx) => post(tx, t, b.narration, 'MANUAL', null, b.legs, b.date));
    await audit(req, 'CREATE', 'Journal', j.id);
    return j;
  });

  app.get('/daybook', async (req) => {
    const { from, to } = range(req.query as Record<string, string>);
    return prisma.journal.findMany({ where: { tenantId: tid(req), date: { gte: from, lte: to } }, include: { entries: { include: { account: { select: { name: true } } } } }, orderBy: { date: 'desc' }, take: 500 });
  });
}
