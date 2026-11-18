export const ROLES = [
  'SUPER_ADMIN', 'OWNER', 'MANAGER', 'ACCOUNTANT', 'SALES',
  'STORE', 'BATCHING', 'DISPATCH', 'DRIVER',
] as const;
export type Role = (typeof ROLES)[number];

export const TRIP_STATES = [
  'ASSIGNED', 'LOADED', 'IN_TRANSIT', 'AT_SITE', 'UNLOADING', 'DELIVERED', 'RETURNED', 'CANCELLED',
] as const;
export type TripState = (typeof TRIP_STATES)[number];

/** Ready-mix concrete HSN code. */
export const RMC_HSN = '38245010';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface LineInput { quantity: number; rate: number; gstRate: number }
export interface TaxBreakup {
  taxable: number; cgst: number; sgst: number; igst: number; total: number;
}

/**
 * GST computation. Intra-state => CGST + SGST (half each); inter-state => IGST.
 * For non-GST documents (bill of supply) pass applyGst = false.
 */
export function computeLine(l: LineInput, interState: boolean, applyGst = true): TaxBreakup {
  const taxable = r2(l.quantity * l.rate);
  if (!applyGst || l.gstRate === 0) return { taxable, cgst: 0, sgst: 0, igst: 0, total: taxable };
  if (interState) {
    const igst = r2((taxable * l.gstRate) / 100);
    return { taxable, cgst: 0, sgst: 0, igst, total: r2(taxable + igst) };
  }
  const half = r2((taxable * l.gstRate) / 200);
  return { taxable, cgst: half, sgst: half, igst: 0, total: r2(taxable + 2 * half) };
}

export function sumBreakups(items: TaxBreakup[]): TaxBreakup {
  return items.reduce(
    (a, b) => ({
      taxable: r2(a.taxable + b.taxable), cgst: r2(a.cgst + b.cgst), sgst: r2(a.sgst + b.sgst),
      igst: r2(a.igst + b.igst), total: r2(a.total + b.total),
    }),
    { taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 },
  );
}

/** Indian financial year label, e.g. 2026-11-18 -> "26-27". */
export function fyLabel(d = new Date()): string {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${String(y).slice(2)}-${String(y + 1).slice(2)}`;
}

export const inr = (n: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(n);
