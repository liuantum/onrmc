import { Prisma } from '@prisma/client';
import { RMC_HSN } from '@onrmc/shared';
import { num } from '../prisma.js';
import { gstinError, paise, pincodeError, stateError } from './validate.js';

/** Everything the IRP payload is built from — loaded by service.ts. */
export const invoiceForIrp = Prisma.validator<Prisma.InvoiceDefaultArgs>()({
  include: {
    tenant: true, customer: true,
    lines: { orderBy: { id: 'asc' }, include: { challan: { include: { vehicle: true, batch: { include: { plant: true } }, order: { include: { site: true } } } } } },
  },
});
export type IrpInvoice = Prisma.InvoiceGetPayload<typeof invoiceForIrp>;

/** Credit / debit note with what its IRP payload needs (original invoice for PrecDocDtls). */
export const noteForIrp = Prisma.validator<Prisma.CreditDebitNoteDefaultArgs>()({
  include: {
    tenant: true, customer: true,
    invoice: { include: { lines: { orderBy: { id: 'asc' }, take: 1, include: { challan: { include: { batch: { include: { plant: true } }, order: { include: { site: true } } } } } } } },
    lines: { orderBy: { id: 'asc' } },
  },
});
export type IrpNote = Prisma.CreditDebitNoteGetPayload<typeof noteForIrp>;

type D = Prisma.Decimal | number;
/** The one shape the payload builder works from — invoices and notes are mapped onto it. */
export interface IrpDoc {
  typ: 'INV' | 'CRN' | 'DBN';
  number: string; issueDate: Date; docKind: string; status: string;
  tenant: IrpInvoice['tenant']; customer: IrpInvoice['customer'];
  placeOfSupply: string; interState: boolean;
  taxable: D; cgst: D; sgst: D; igst: D; roundOff: D; total: D;
  lines: { challanId: string | null; description: string; hsn: string; quantity: D | null; unit: string; rate: D; gstRate: D; taxable: D; tax: D; total: D }[];
  site?: { name: string; address: string | null; city: string | null; pincode: string | null; stateCode: string } | null;
  plant?: { name: string; address: string | null; pincode: string | null } | null;
  preceding?: { no: string; dt: Date };
}

export function invoiceDoc(inv: IrpInvoice): IrpDoc {
  const first = inv.lines.find((l) => l.challan)?.challan;
  return {
    typ: 'INV', number: inv.number, issueDate: inv.issueDate, docKind: inv.type, status: inv.status, tenant: inv.tenant, customer: inv.customer,
    placeOfSupply: inv.placeOfSupply, interState: inv.interState, taxable: inv.taxable, cgst: inv.cgst, sgst: inv.sgst, igst: inv.igst, roundOff: inv.roundOff, total: inv.total,
    lines: inv.lines, site: first?.order.site, plant: first?.batch?.plant,
  };
}

export function noteDoc(n: IrpNote): IrpDoc {
  const first = n.invoice.lines[0]?.challan;
  return {
    typ: n.type === 'CREDIT' ? 'CRN' : 'DBN', number: n.number, issueDate: n.issueDate, docKind: n.invoice.type, status: n.status, tenant: n.tenant, customer: n.customer,
    placeOfSupply: n.placeOfSupply, interState: n.interState, taxable: n.taxable, cgst: n.cgst, sgst: n.sgst, igst: n.igst, roundOff: n.roundOff, total: n.total,
    lines: n.lines.map((l) => ({ ...l, challanId: null })), site: first?.order.site, plant: first?.batch?.plant,
    preceding: { no: n.invoice.number, dt: n.invoice.issueDate },
  };
}

/** NIC IRP e-invoice schema v1.1 (only the parts onrmc uses). */
export interface IrpPayload {
  Version: '1.1';
  TranDtls: { TaxSch: 'GST'; SupTyp: 'B2B'; RegRev: 'N'; EcmGstin: null; IgstOnIntra: 'N' };
  DocDtls: { Typ: 'INV' | 'CRN' | 'DBN'; No: string; Dt: string };
  RefDtls?: { PrecDocDtls: { InvNo: string; InvDt: string }[] };
  SellerDtls: Party;
  BuyerDtls: Party & { Pos: string };
  DispDtls?: { Nm: string; Addr1: string; Loc: string; Pin: number; Stcd: string };
  ShipDtls?: { LglNm: string; Addr1: string; Loc: string; Pin: number; Stcd: string; Gstin?: string };
  ItemList: Item[];
  ValDtls: { AssVal: number; CgstVal: number; SgstVal: number; IgstVal: number; CesVal: 0; StCesVal: 0; Discount: 0; OthChrg: 0; RndOffAmt: number; TotInvVal: number };
}
interface Party { Gstin: string; LglNm: string; TrdNm?: string; Addr1: string; Loc: string; Pin: number; Stcd: string; Ph?: string; Em?: string }
interface Item {
  SlNo: string; PrdDesc: string; IsServc: 'Y' | 'N'; HsnCd: string; Qty?: number; Unit?: string; UnitPrice: number;
  TotAmt: number; Discount: 0; AssAmt: number; GstRt: number; IgstAmt: number; CgstAmt: number; SgstAmt: number;
  CesRt: 0; CesAmt: 0; CesNonAdvlAmt: 0; StateCesRt: 0; StateCesAmt: 0; StateCesNonAdvlAmt: 0; OthChrg: 0; TotItemVal: number;
}

/** GST unit quantity codes (UQC). */
const UQC: Record<string, string> = { M3: 'CBM', CBM: 'CBM', NOS: 'NOS', KG: 'KGS', KGS: 'KGS', TON: 'TON', LTR: 'LTR', HRS: 'OTH', TRIP: 'OTH' };

/** dd/mm/yyyy in IST, as the IRP expects. */
export function irpDate(d: Date) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g('day')}/${g('month')}/${g('year')}`;
}

const cut = (s: string | null | undefined, n: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const r2 = (n: number) => Math.round(n * 100) / 100;

export class EinvoiceValidationError extends Error {
  constructor(public problems: string[]) { super(problems.join('; ')); }
}

/** Why an invoice does not need an IRN, or null if it does. */
export function notRequiredReason(inv: { type: string; status: string; customer: { gstin: string | null } }): string | null {
  if (inv.type !== 'TAX_INVOICE') return 'A bill of supply (or a note against one) does not need an e-invoice';
  if (inv.status === 'CANCELLED') return 'Invoice is cancelled';
  if (!inv.customer.gstin) return 'B2C invoice (customer has no GSTIN) does not need an e-invoice';
  return null;
}

/**
 * Builds the IRP JSON from the issued invoice exactly as stored — the same line items and
 * server-computed totals that are in the books and the GST summary. Nothing is recomputed
 * or adjusted here; if the stored figures do not reconcile to the paise we refuse to send.
 */
export function buildIrpPayload(inv: IrpInvoice): IrpPayload {
  return buildIrpPayloadFromDoc(invoiceDoc(inv));
}

export function buildIrpPayloadFromDoc(inv: IrpDoc): IrpPayload {
  const problems: string[] = [];
  const nr = notRequiredReason({ type: inv.docKind, status: inv.status, customer: inv.customer });
  if (nr) throw new EinvoiceValidationError([nr]);
  const t = inv.tenant, c = inv.customer;
  const push = (e: string | null) => { if (e) problems.push(e); };
  push(gstinError(t.gstin, 'Your company'));
  push(gstinError(c.gstin, 'Customer'));
  push(stateError(t.stateCode, 'Your company'));
  push(stateError(c.stateCode, 'Customer'));
  push(stateError(inv.placeOfSupply, 'Place of supply'));
  push(pincodeError(t.pincode, 'Your company'));
  push(pincodeError(c.pincode, 'Customer'));
  if (t.gstin && t.gstin.slice(0, 2) !== t.stateCode) problems.push(`Your GSTIN ${t.gstin} does not match your state code ${t.stateCode}`);
  if (c.gstin && c.gstin.slice(0, 2) !== c.stateCode) problems.push(`Customer GSTIN ${c.gstin} does not match customer state code ${c.stateCode}`);
  if (!/^[A-Za-z1-9][A-Za-z0-9/-]{0,15}$/.test(inv.number)) problems.push(`Document number ${inv.number} is not allowed by the IRP (max 16 chars, letters/digits/ / -)`);
  if (!cut(t.address, 100) || cut(t.address, 100).length < 3) problems.push('Your company address is missing');
  if (!cut(c.billingAddress, 100) || cut(c.billingAddress, 100).length < 3) problems.push('Customer billing address is missing');
  if (!inv.lines.length) problems.push('Invoice has no lines');

  const items: Item[] = inv.lines.map((l, i) => {
    const hasQty = l.quantity != null && num(l.quantity) > 0;
    const qtyN = num(l.quantity), rate = num(l.rate), taxable = num(l.taxable), tax = num(l.tax), total = num(l.total), gstRate = num(l.gstRate);
    const isConcrete = !!l.challanId || l.hsn.startsWith('3824');
    if (isConcrete && !l.hsn.startsWith('3824')) problems.push(`Line ${i + 1}: concrete must use HSN 3824 (found ${l.hsn})`);
    if (!isConcrete && !l.hsn.startsWith('99')) problems.push(`Line ${i + 1} (${l.description}): service charges must use a SAC code starting 99 (found ${l.hsn})`);
    if (!/^[0-9]{4,8}$/.test(l.hsn)) problems.push(`Line ${i + 1}: HSN/SAC ${l.hsn} must be 4–8 digits`);
    if (hasQty && paise(qtyN * rate) !== paise(taxable)) problems.push(`Line ${i + 1}: quantity × rate does not equal the taxable value`);
    if (paise(taxable + tax) !== paise(total)) problems.push(`Line ${i + 1}: taxable + tax does not equal the line total`);
    // Split tax exactly as stored: IGST for inter-state, else equal CGST/SGST halves.
    const igst = inv.interState ? tax : 0;
    const cgst = inv.interState ? 0 : r2(tax / 2);
    const sgst = inv.interState ? 0 : r2(tax - cgst);
    return {
      SlNo: String(i + 1), PrdDesc: cut(l.description, 300), IsServc: isConcrete ? 'N' : 'Y', HsnCd: isConcrete ? (l.hsn || RMC_HSN) : l.hsn,
      // value-only note lines (lump-sum discount) carry no quantity; UnitPrice = amount
      ...(hasQty ? { Qty: qtyN, Unit: UQC[l.unit.toUpperCase()] ?? 'OTH' } : {}), UnitPrice: hasQty ? rate : taxable, TotAmt: taxable, Discount: 0, AssAmt: taxable, GstRt: gstRate,
      IgstAmt: igst, CgstAmt: cgst, SgstAmt: sgst, CesRt: 0, CesAmt: 0, CesNonAdvlAmt: 0, StateCesRt: 0, StateCesAmt: 0, StateCesNonAdvlAmt: 0, OthChrg: 0, TotItemVal: total,
    };
  });

  const sum = (k: keyof Item) => r2(items.reduce((s, x) => s + (x[k] as number), 0));
  const val = {
    AssVal: num(inv.taxable), CgstVal: num(inv.cgst), SgstVal: num(inv.sgst), IgstVal: num(inv.igst),
    CesVal: 0 as const, StCesVal: 0 as const, Discount: 0 as const, OthChrg: 0 as const, RndOffAmt: num(inv.roundOff), TotInvVal: num(inv.total),
  };
  // Reconcile to the paise against the invoice header (= what is in the ledger and GST summary).
  if (paise(sum('AssAmt')) !== paise(val.AssVal)) problems.push('Line taxable values do not add up to the invoice taxable value');
  if (paise(sum('CgstAmt')) !== paise(val.CgstVal)) problems.push('Line CGST does not add up to the invoice CGST');
  if (paise(sum('SgstAmt')) !== paise(val.SgstVal)) problems.push('Line SGST does not add up to the invoice SGST');
  if (paise(sum('IgstAmt')) !== paise(val.IgstVal)) problems.push('Line IGST does not add up to the invoice IGST');
  if (paise(val.AssVal + val.CgstVal + val.SgstVal + val.IgstVal + val.RndOffAmt) !== paise(val.TotInvVal)) problems.push('Taxable + GST + round-off does not equal the invoice total');
  if (Math.abs(val.RndOffAmt) > 99.99) problems.push('Round-off is outside what the IRP accepts');
  if (problems.length) throw new EinvoiceValidationError(problems);

  const site = inv.site;
  const plant = inv.plant;
  const payload: IrpPayload = {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', EcmGstin: null, IgstOnIntra: 'N' },
    DocDtls: { Typ: inv.typ, No: inv.number, Dt: irpDate(inv.issueDate) },
    ...(inv.preceding ? { RefDtls: { PrecDocDtls: [{ InvNo: inv.preceding.no, InvDt: irpDate(inv.preceding.dt) }] } } : {}),
    SellerDtls: { Gstin: t.gstin!.toUpperCase(), LglNm: cut(t.legalName ?? t.name, 100), TrdNm: cut(t.name, 100), Addr1: cut(t.address, 100), Loc: cut(t.city ?? t.address, 50), Pin: Number(t.pincode), Stcd: t.stateCode, ...(t.phone ? { Ph: cut(t.phone, 12) } : {}), ...(t.email ? { Em: cut(t.email, 100) } : {}) },
    BuyerDtls: { Gstin: c.gstin!.toUpperCase(), LglNm: cut(c.name, 100), Pos: inv.placeOfSupply, Addr1: cut(c.billingAddress, 100), Loc: cut(c.city ?? c.billingAddress, 50), Pin: Number(c.pincode), Stcd: c.stateCode, ...(c.phone ? { Ph: cut(c.phone, 12) } : {}), ...(c.email ? { Em: cut(c.email, 100) } : {}) },
    ItemList: items,
    ValDtls: val,
  };
  // Ship-to = the delivery site when it has a PIN; dispatch-from = the plant when it has a PIN.
  if (site?.pincode && !pincodeError(site.pincode, 'Site')) {
    payload.ShipDtls = { LglNm: cut(c.name, 100), Addr1: cut(site.address ?? site.name, 100), Loc: cut(site.city ?? site.name, 50), Pin: Number(site.pincode), Stcd: site.stateCode };
  }
  if (plant?.pincode && !pincodeError(plant.pincode, 'Plant') && plant.pincode !== t.pincode) {
    payload.DispDtls = { Nm: cut(t.legalName ?? t.name, 100), Addr1: cut(plant.address ?? plant.name, 100), Loc: cut(plant.name, 50), Pin: Number(plant.pincode), Stcd: t.stateCode };
  }
  return payload;
}
