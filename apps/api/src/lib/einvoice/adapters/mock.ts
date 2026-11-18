import { createHash, createHmac } from 'node:crypto';
import type { IrpPayload } from '../payload.js';
import { ewbValidUpto, GspError, type EwbByIrnInput, type ExtendInput, type GspAdapter, type IrnResult, type PartBInput } from './types.js';

const b64u = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
/** Looks like the IRP's signed JWTs; signature is an HMAC with a fixed mock key (not verifiable by NIC). */
function fakeJwt(data: unknown) {
  const head = b64u({ alg: 'RS256', kid: 'MOCK-IRP', typ: 'JWT', x5t: 'mock' });
  const body = b64u({ data: JSON.stringify(data), iss: 'NIC Sandbox (onrmc MOCK)' });
  return `${head}.${body}.${createHmac('sha256', 'onrmc-mock').update(`${head}.${body}`).digest('base64url')}`;
}
const digits = (seed: string, n: number) => {
  const h = BigInt('0x' + createHash('sha256').update(seed).digest('hex'));
  return (h % 10n ** BigInt(n)).toString().padStart(n, '0').replace(/^0/, '1');
};

/**
 * Offline adapter for development and demos. Behaves like the IRP for the rules that matter
 * to onrmc (deterministic IRN per document, 24h cancel window, e-way bill validity by distance),
 * but nothing it returns is a legal e-invoice.
 */
export class MockAdapter implements GspAdapter {
  readonly name = 'MOCK';
  private static irns = new Map<string, { result: IrnResult; payload: IrpPayload; cancelled?: Date }>();
  private static ewbs = new Map<string, { ewbDate: Date; validUpto: Date | null; distance: number; cancelled?: Date }>();

  async testConnection() { return { ok: true as const, message: 'Mock provider ready (offline, no real IRNs)' }; }

  /** NIC computes the IRN as SHA-256 of seller GSTIN + FY + doc type + doc no; we do the same. */
  private irnFor(p: IrpPayload) {
    const [, m, y] = p.DocDtls.Dt.split('/').map(Number);
    const fy = m >= 4 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
    return createHash('sha256').update(`${p.SellerDtls.Gstin}${fy}${p.DocDtls.Typ}${p.DocDtls.No.toUpperCase()}`).digest('hex');
  }

  async generateIrn(p: IrpPayload): Promise<IrnResult> {
    const irn = this.irnFor(p);
    const existing = MockAdapter.irns.get(irn);
    if (existing && !existing.cancelled) throw new GspError('Duplicate IRN — an IRN already exists for this document', '2150', { irn });
    if (existing?.cancelled) throw new GspError('IRN for this document was cancelled; a cancelled document number cannot be reused', '2270');
    const ackDate = new Date();
    const ackNo = digits(irn + ackDate.toISOString(), 15);
    const mainHsn = p.ItemList.reduce((a, b) => (b.AssAmt > a.AssAmt ? b : a)).HsnCd;
    const signedQr = fakeJwt({
      SellerGstin: p.SellerDtls.Gstin, BuyerGstin: p.BuyerDtls.Gstin, DocNo: p.DocDtls.No, DocTyp: p.DocDtls.Typ, DocDt: p.DocDtls.Dt,
      TotInvVal: p.ValDtls.TotInvVal, ItemCnt: p.ItemList.length, MainHsnCode: mainHsn, Irn: irn, IrnDt: ackDate.toISOString().replace('T', ' ').slice(0, 19),
    });
    const result: IrnResult = { irn, ackNo, ackDate, signedQr, signedInvoice: fakeJwt({ ...p, Irn: irn, AckNo: ackNo, AckDt: ackDate }), raw: { Status: 1, mock: true } };
    MockAdapter.irns.set(irn, { result, payload: p });
    return result;
  }

  async cancelIrn(irn: string) {
    const e = MockAdapter.irns.get(irn);
    if (e && Date.now() - e.result.ackDate.getTime() > 24 * 3600e3) throw new GspError('IRN can be cancelled only within 24 hours of generation', '2270');
    if (e?.cancelled) throw new GspError('IRN is already cancelled', '9999');
    const cancelledAt = new Date();
    if (e) e.cancelled = cancelledAt;
    return { cancelledAt, raw: { Irn: irn, CancelDate: cancelledAt, mock: true } };
  }

  async getIrnByDocNo(t: 'INV' | 'CRN' | 'DBN', docNo: string) {
    for (const e of MockAdapter.irns.values()) if (e.payload.DocDtls.Typ === t && e.payload.DocDtls.No === docNo && !e.cancelled) return e.result;
    return null;
  }

  async generateEwbByIrn(i: EwbByIrnInput) {
    if (i.distanceKm > 4000) throw new GspError('Distance cannot exceed 4000 km', '702');
    // The portal computes PIN-to-PIN distance when 0 is sent; mock uses 10 km within the same PIN area.
    const distance = i.distanceKm || (i.fromPin === i.toPin ? 10 : 25);
    const ewbDate = new Date();
    const ewbNo = digits(i.irn + ewbDate.toISOString(), 12);
    const validUpto = i.vehicleNo ? ewbValidUpto(ewbDate, distance) : null; // Part-A only until a vehicle is added
    MockAdapter.ewbs.set(ewbNo, { ewbDate, validUpto, distance });
    return { ewbNo, ewbDate, validUpto, raw: { EwbNo: ewbNo, EwbDt: ewbDate, EwbValidTill: validUpto, Distance: distance, mock: true } };
  }

  async updatePartB(i: PartBInput) {
    const e = MockAdapter.ewbs.get(i.ewbNo);
    if (e?.cancelled) throw new GspError('E-way bill is cancelled', '312');
    if (e?.validUpto && e.validUpto < new Date()) throw new GspError('E-way bill validity has expired', '336');
    const validUpto = e?.validUpto ?? ewbValidUpto(new Date(), e?.distance ?? 25);
    if (e) e.validUpto = validUpto;
    return { validUpto, raw: { vehUpdDate: new Date(), validUpto, mock: true } };
  }

  async cancelEwb(ewbNo: string) {
    const e = MockAdapter.ewbs.get(ewbNo);
    if (e && Date.now() - e.ewbDate.getTime() > 24 * 3600e3) throw new GspError('E-way bill can be cancelled only within 24 hours', '315');
    const cancelledAt = new Date();
    if (e) e.cancelled = cancelledAt;
    return { cancelledAt, raw: { ewayBillNo: ewbNo, cancelDate: cancelledAt, mock: true } };
  }

  async extendValidity(i: ExtendInput) {
    const e = MockAdapter.ewbs.get(i.ewbNo);
    const now = new Date();
    if (e?.validUpto && Math.abs(e.validUpto.getTime() - now.getTime()) > 8 * 3600e3) throw new GspError('Validity can be extended only within 8 hours before or after expiry', '381');
    const validUpto = ewbValidUpto(now, i.remainingDistanceKm);
    if (e) e.validUpto = validUpto;
    return { validUpto, raw: { validUpto, mock: true } };
  }
}
