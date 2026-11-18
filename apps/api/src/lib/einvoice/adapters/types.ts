import type { IrpPayload } from '../payload.js';

export interface IrnResult {
  irn: string; ackNo: string; ackDate: Date; signedInvoice: string; signedQr: string;
  /** Raw response kept for the audit log. */
  raw?: unknown;
}
export interface EwbResult { ewbNo: string; ewbDate: Date; validUpto: Date | null; raw?: unknown }

export interface EwbByIrnInput {
  irn: string; distanceKm: number; transMode: '1' | '2' | '3' | '4'; vehicleNo: string; vehicleType: 'R' | 'O';
  transporterId?: string; transporterName?: string;
  /** Dispatch-from / ship-to PINs (used by the portal to check or compute distance). */
  fromPin: number; fromState: string; toPin: number; toState: string;
}
export interface PartBInput { ewbNo: string; vehicleNo: string; fromPlace: string; fromState: string; reasonCode: '1' | '2' | '3' | '4'; reasonRemark: string; transMode: '1' | '2' | '3' | '4' }
export interface ExtendInput { ewbNo: string; vehicleNo: string; fromPlace: string; fromState: string; fromPin: number; remainingDistanceKm: number; reasonCode: '1' | '2' | '3' | '4' | '99'; reasonRemark: string }

/** IRN cancel reason codes (IRP): 1 duplicate, 2 data entry mistake, 3 order cancelled, 4 others. */
export type IrnCancelCode = '1' | '2' | '3' | '4';
/** E-way bill cancel reason codes: 1 duplicate, 2 order cancelled, 3 data entry mistake, 4 others. */
export type EwbCancelCode = '1' | '2' | '3' | '4';

/** One implementation per GST Suvidha Provider (or NIC direct). */
export interface GspAdapter {
  readonly name: string;
  testConnection(): Promise<{ ok: true; message: string }>;
  generateIrn(payload: IrpPayload): Promise<IrnResult>;
  cancelIrn(irn: string, reason: IrnCancelCode, remark: string): Promise<{ cancelledAt: Date; raw?: unknown }>;
  getIrnByDocNo(docType: 'INV' | 'CRN' | 'DBN', docNo: string, docDate: string): Promise<IrnResult | null>;
  generateEwbByIrn(input: EwbByIrnInput): Promise<EwbResult>;
  updatePartB(input: PartBInput): Promise<{ validUpto: Date | null; raw?: unknown }>;
  cancelEwb(ewbNo: string, reason: EwbCancelCode, remark: string): Promise<{ cancelledAt: Date; raw?: unknown }>;
  extendValidity(input: ExtendInput): Promise<{ validUpto: Date; raw?: unknown }>;
}

/** Error from the provider / portal, with the portal's error code when there is one. */
export class GspError extends Error {
  constructor(message: string, public code?: string, public raw?: unknown) { super(message); }
}

/** E-way bill validity: 1 day per 200 km (part thereof), each day ending at midnight of the following day. */
export function ewbValidUpto(from: Date, distanceKm: number) {
  const days = Math.max(1, Math.ceil(distanceKm / 200));
  // midnight IST of (generation date + days)
  const ist = new Date(from.getTime() + 330 * 60e3);
  const endIst = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + days, 23, 59, 59);
  return new Date(endIst - 330 * 60e3);
}
