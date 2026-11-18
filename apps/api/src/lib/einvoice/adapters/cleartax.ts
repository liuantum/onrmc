import type { IrpPayload } from '../payload.js';
import { gspFetch, portalDate, todayIst, type GspEnv } from './http.js';
import { GspError, type EwbByIrnInput, type EwbCancelCode, type ExtendInput, type GspAdapter, type IrnCancelCode, type IrnResult, type PartBInput } from './types.js';

/**
 * ClearTax (Clear) GSP — e-invoice API v2 and e-way bill API.
 * Auth: X-Cleartax-Auth-Token + gstin (+ owner_id) headers. Body for IRN is the NIC schema wrapped as
 * [{ transaction: <payload> }]; the answer carries the IRP's own response under govt_response.
 * Sandbox: https://api-sandbox.clear.in · Production: https://api.clear.in
 */
export class ClearTaxAdapter implements GspAdapter {
  readonly name = 'CLEARTAX';
  private base: string;
  constructor(private creds: { authToken: string; ownerId?: string }, private gstin: string, readonly env: GspEnv) {
    this.base = env === 'production' ? 'https://api.clear.in' : 'https://api-sandbox.clear.in';
  }
  private headers() {
    return { 'X-Cleartax-Auth-Token': this.creds.authToken, gstin: this.gstin, ...(this.creds.ownerId ? { owner_id: this.creds.ownerId } : {}) };
  }
  private async call(method: string, path: string, body?: unknown) {
    const { status, json } = await gspFetch(`${this.base}${path}`, { method, headers: this.headers(), body });
    return { status, json };
  }
  /** govt_response.Success === 'Y' or throws with the IRP's first error code. */
  private govt(json: any) {
    const row = Array.isArray(json) ? json[0] : json;
    const g = row?.govt_response ?? row;
    if (g?.Success === 'Y' || g?.Success === true) return g;
    const err = g?.ErrorDetails?.[0] ?? row?.error ?? json?.errors?.[0];
    throw new GspError(err?.error_message ?? err?.ErrorMessage ?? err?.message ?? 'ClearTax returned an error', err?.error_code ?? err?.ErrorCode ?? err?.code, json);
  }
  private irn(g: any): IrnResult {
    return { irn: g.Irn, ackNo: String(g.AckNo), ackDate: portalDate(g.AckDt) ?? new Date(), signedInvoice: g.SignedInvoice, signedQr: g.SignedQRCode, raw: { AckNo: g.AckNo, AckDt: g.AckDt, Irn: g.Irn, Status: g.Status } };
  }

  async testConnection() {
    // An unknown IRN lookup authenticates without creating anything: 401/403 throws AUTH in gspFetch.
    await this.call('GET', `/einv/v2/eInvoice/get?irn=${'0'.repeat(64)}`);
    return { ok: true as const, message: `ClearTax ${this.env} accepted the credentials for ${this.gstin}` };
  }
  async generateIrn(p: IrpPayload) {
    const { json } = await this.call('PUT', '/einv/v2/eInvoice/generate', [{ transaction: p }]);
    return this.irn(this.govt(json));
  }
  async cancelIrn(irn: string, reason: IrnCancelCode, remark: string) {
    const { json } = await this.call('PUT', '/einv/v2/eInvoice/cancel', [{ irn, CnlRsn: reason, CnlRem: remark }]);
    const g = this.govt(json);
    return { cancelledAt: portalDate(g.CancelDate) ?? new Date(), raw: g };
  }
  async getIrnByDocNo(docType: 'INV' | 'CRN' | 'DBN', docNo: string, docDate: string) {
    const { status, json } = await this.call('GET', `/einv/v2/eInvoice/get-by-doc?docType=${docType}&docNum=${encodeURIComponent(docNo)}&docDate=${encodeURIComponent(docDate)}`);
    if (status === 404) return null;
    try { return this.irn(this.govt(json)); } catch { return null; }
  }
  async generateEwbByIrn(i: EwbByIrnInput) {
    const { json } = await this.call('POST', '/einv/v2/eInvoice/ewaybill', [{
      Irn: i.irn, Distance: i.distanceKm, TransMode: i.transMode, TransId: i.transporterId || null, TransName: i.transporterName || null,
      TransDocDt: i.vehicleNo ? todayIst() : null, TransDocNo: null, VehNo: i.vehicleNo || null, VehType: i.vehicleNo ? i.vehicleType : null,
    }]);
    const g = this.govt(json);
    return { ewbNo: String(g.EwbNo), ewbDate: portalDate(g.EwbDt) ?? new Date(), validUpto: portalDate(g.EwbValidTill), raw: g };
  }
  async updatePartB(i: PartBInput) {
    const { json } = await this.call('POST', '/einv/v1/ewaybill/update?action=PARTB', {
      EwbNumber: Number(i.ewbNo), FromPlace: i.fromPlace, FromState: Number(i.fromState), ReasonCode: i.reasonCode, ReasonRemark: i.reasonRemark,
      TransMode: i.transMode, VehicleType: 'REGULAR', VehNo: i.vehicleNo,
    });
    if (json?.errors?.length || json?.error) this.govt({ Success: 'N', ErrorDetails: json.errors ?? [json.error] });
    return { validUpto: portalDate(json?.ValidUpto ?? json?.validUpto), raw: json };
  }
  async cancelEwb(ewbNo: string, reason: EwbCancelCode, remark: string) {
    const { json } = await this.call('POST', '/einv/v2/eInvoice/ewaybill/cancel', { ewbNo: Number(ewbNo), cancelRsnCode: ['', 'DUPLICATE', 'ORDER_CANCELLED', 'DATA_ENTRY_MISTAKE', 'OTHERS'][Number(reason)], cancelRmrk: remark });
    if (json?.errors?.length || json?.error) this.govt({ Success: 'N', ErrorDetails: json.errors ?? [json.error] });
    return { cancelledAt: portalDate(json?.cancelDate ?? json?.CancelDate) ?? new Date(), raw: json };
  }
  async extendValidity(i: ExtendInput) {
    const { json } = await this.call('POST', '/einv/v1/ewaybill/update?action=EXTEND', {
      EwbNumber: Number(i.ewbNo), VehNo: i.vehicleNo, FromPlace: i.fromPlace, FromState: Number(i.fromState), FromPincode: i.fromPin,
      RemainingDistance: i.remainingDistanceKm, TransMode: '1', ConsignmentStatus: 'MOVEMENT', ExtnRsnCode: i.reasonCode, ExtnRemarks: i.reasonRemark,
    });
    const v = portalDate(json?.ValidUpto ?? json?.validUpto);
    if (!v) this.govt({ Success: 'N', ErrorDetails: json?.errors ?? [json?.error ?? { error_message: 'ClearTax did not return a new validity date' }] });
    return { validUpto: v!, raw: json };
  }
}
