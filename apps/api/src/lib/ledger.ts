import type { Tx } from './prisma.js';

/** System accounts created for every tenant. */
export const SYSTEM_ACCOUNTS = [
  { code: '1100', name: 'Cash', type: 'ASSET', group: 'Cash-in-hand' },
  { code: '1200', name: 'Bank', type: 'ASSET', group: 'Bank Accounts' },
  { code: '1300', name: 'Sundry Debtors', type: 'ASSET', group: 'Sundry Debtors' },
  { code: '1400', name: 'Inventory - Raw Materials', type: 'ASSET', group: 'Stock-in-hand' },
  { code: '1500', name: 'GST Input Credit', type: 'ASSET', group: 'Duties & Taxes' },
  { code: '1520', name: 'TCS receivable', type: 'ASSET', group: 'Duties & Taxes' },
  { code: '1530', name: 'Supplier claims (short supply)', type: 'ASSET', group: 'Loans & Advances' },
  { code: '2100', name: 'Sundry Creditors', type: 'LIABILITY', group: 'Sundry Creditors' },
  { code: '2150', name: 'Goods received, not billed', type: 'LIABILITY', group: 'Current Liabilities' },
  { code: '2200', name: 'CGST Output', type: 'LIABILITY', group: 'Duties & Taxes' },
  { code: '2210', name: 'SGST Output', type: 'LIABILITY', group: 'Duties & Taxes' },
  { code: '2220', name: 'IGST Output', type: 'LIABILITY', group: 'Duties & Taxes' },
  { code: '2230', name: 'GST payable on reverse charge', type: 'LIABILITY', group: 'Duties & Taxes' },
  { code: '2300', name: 'TDS payable', type: 'LIABILITY', group: 'Duties & Taxes' },
  { code: '3000', name: 'Capital', type: 'EQUITY', group: 'Capital Account' },
  { code: '4000', name: 'Sales - RMC', type: 'INCOME', group: 'Sales Accounts' },
  { code: '4100', name: 'Pumping & Other Charges', type: 'INCOME', group: 'Sales Accounts' },
  { code: '4900', name: 'Sales returns & discounts', type: 'INCOME', group: 'Sales Accounts' },
  { code: '5000', name: 'Cost of materials consumed', type: 'EXPENSE', group: 'Direct Expenses' },
  { code: '5100', name: 'Diesel / Fuel expense', type: 'EXPENSE', group: 'Direct Expenses' },
  { code: '5200', name: 'Salaries & Wages', type: 'EXPENSE', group: 'Indirect Expenses' },
  { code: '5300', name: 'Plant Maintenance', type: 'EXPENSE', group: 'Indirect Expenses' },
  { code: '5400', name: 'Round off', type: 'EXPENSE', group: 'Indirect Expenses' },
] as const;

export async function accountId(tx: Tx, tenantId: string, code: string) {
  const a = await tx.account.findUniqueOrThrow({ where: { tenantId_code: { tenantId, code } } });
  return a.id;
}

export interface Leg { accountId: string; debit?: number; credit?: number }

/** Posts a balanced journal. Throws if debits ≠ credits. */
export async function post(
  tx: Tx, tenantId: string, narration: string, sourceType: string, sourceId: string | null, legs: Leg[],
  date = new Date(),
) {
  // a negative amount belongs on the other side (e.g. a negative round-off)
  const legsNz = legs
    .map((l) => { const n = (l.debit ?? 0) - (l.credit ?? 0); return { accountId: l.accountId, debit: n > 0 ? n : 0, credit: n < 0 ? -n : 0 }; })
    .filter((l) => l.debit !== 0 || l.credit !== 0);
  const dr = legsNz.reduce((s, l) => s + (l.debit ?? 0), 0);
  const cr = legsNz.reduce((s, l) => s + (l.credit ?? 0), 0);
  if (Math.abs(dr - cr) > 0.005) throw new Error(`Unbalanced journal: Dr ${dr} ≠ Cr ${cr}`);
  return tx.journal.create({
    data: {
      tenantId, narration, sourceType, sourceId, date,
      entries: { create: legsNz.map((l) => ({ accountId: l.accountId, debit: l.debit ?? 0, credit: l.credit ?? 0 })) },
    },
  });
}
