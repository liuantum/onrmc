import type { IrpPayload } from '../payload.js';
import { gspFetch, portalDate, todayIst, type GspEnv } from './http.js';
import { GspError, type EwbByIrnInput, type EwbCancelCode, type ExtendInput, type GspAdapter, type GstinDetails, type IrnCancelCode, type IrnResult, type PartBInput } from './types.js';

const STATE_NAMES: Record<string, string> = {
  '01': 'JAMMU AND KASHMIR', '02': 'HIMACHAL PRADESH', '03': 'PUNJAB', '04': 'CHANDIGARH', '05': 'UTTARAKHAND', '06': 'HARYANA', '07': 'DELHI', '08': 'RAJASTHAN',
  '09': 'UTTAR PRADESH', '10': 'BIHAR', '11': 'SIKKIM', '12': 'ARUNACHAL PRADESH', '13': 'NAGALAND', '14': 'MANIPUR', '15': 'MIZORAM', '16': 'TRIPURA', '17': 'MEGHALAYA',
  '18': 'ASSAM', '19': 'WEST BENGAL', '20': 'JHARKHAND', '21': 'ODISHA', '22': 'CHHATTISGARH', '23': 'MADHYA PRADESH', '24': 'GUJARAT', '26': 'DADRA AND NAGAR HAVELI AND DAMAN AND DIU',
  '27': 'MAHARASHTRA', '29': 'KARNATAKA', '30': 'GOA', '31': 'LAKSHADWEEP', '32': 'KERALA', '33': 'TAMIL NADU', '34': 'PUDUCHERRY', '35': 'ANDAMAN AND NICOBAR', '36': 'TELANGANA',
  '37': 'ANDHRA PRADESH', '38': 'LADAKH', '97': 'OTHER TERRITORY',
};
const EWB_CANCEL = ['', 'Duplicate', 'Order Cancelled', 'Data Entry mistake', 'Others'];
const PARTB_REASON = ['', 'Due to Break Down', 'Due to Transhipment', 'Others', 'First Time'];
const EXTEND_REASON: Record<string, string> = { '1': 'Natural Calamity', '2': 'Law and Order Situation', '3': 'Transhipment', '4': 'Accident', '99': 'Others' };
const MODE = ['', 'Road', 'Rail', 'Air', 'Ship'];

/**
 * Masters India GSP. Uses its own flat JSON (snake_case) rather than the NIC schema, so the NIC payload
 * is mapped field by field — values are copied, never recomputed.
 * Auth: POST /api/v1/token-auth/ → JWT, sent as "Authorization: JWT <token>" plus access_token in the body.
 * Sandbox: https://sandb-api.mastersindia.co · Production: https://prod-api.mastersindia.co
 */
export class MastersIndiaAdapter implements GspAdapter {
  readonly name = 'MASTERS_INDIA';
  private base: string;
  private static tokens = new Map<string, { token: string; at: number }>();
  constructor(private creds: { username: string; password: string; clientId?: string; clientSecret?: string }, private gstin: string, readonly env: GspEnv) {
    this.base = env === 'production' ? 'https://prod-api.mastersindia.co' : 'https://sandb-api.mastersindia.co';
  }

  private async token(force = false) {
    const k = `${this.env}:${this.creds.username}`;
    const c = MastersIndiaAdapter.tokens.get(k);
    if (!force && c && Date.now() - c.at < 20 * 3600e3) return c.token; // tokens live ~24 h
    const { json } = await gspFetch(`${this.base}/api/v1/token-auth/`, { method: 'POST', headers: {}, body: { username: this.creds.username, password: this.creds.password, ...(this.creds.clientId ? { client_id: this.creds.clientId, client_secret: this.creds.clientSecret } : {}) } });
    if (!json?.token) throw new GspError(json?.error ?? json?.non_field_errors?.[0] ?? 'Masters India did not return a token — check username and password', 'AUTH', json);
    MastersIndiaAdapter.tokens.set(k, { token: json.token, at: Date.now() });
    return json.token as string;
  }
  private async call(path: string, body: Record<string, unknown>, retried = false): Promise<any> {
    const token = await this.token();
    try {
      const { json } = await gspFetch(`${this.base}${path}`, { method: 'POST', headers: { Authorization: `JWT ${token}` }, body: { access_token: token, ...body } });
      return this.result(json);
    } catch (e) {
      if (!retried && e instanceof GspError && e.code === 'AUTH') { await this.token(true); return this.call(path, body, true); }
      throw e;
    }
  }
  /** { results: { message, status: 'Success'|'Failed', errorMessage, code } } */
  private result(json: any) {
    const r = json?.results ?? json;
    if (r?.status === 'Success' || r?.code === 200) return r.message;
    const msg: string = r?.errorMessage ?? (typeof r?.message === 'string' ? r.message : null) ?? 'Masters India returned an error';
    const code = /^(\d{3,4})\s*[:-]/.exec(msg)?.[1] ?? (/Duplicate IRN/i.test(msg) ? '2150' : undefined);
    throw new GspError(msg, code, json);
  }

  /** NIC schema → Masters India request (same numbers, renamed fields). */
  static toMastersIndia(p: IrpPayload, gstin: string) {
    const party = (x: IrpPayload['SellerDtls']) => ({ gstin: x.Gstin, legal_name: x.LglNm, trade_name: x.TrdNm ?? x.LglNm, address1: x.Addr1, location: x.Loc, pincode: x.Pin, state_code: STATE_NAMES[x.Stcd] ?? x.Stcd, phone_number: x.Ph ?? null, email: x.Em ?? null });
    return {
      user_gstin: gstin, data_source: 'erp',
      transaction_details: { supply_type: p.TranDtls.SupTyp, charge_type: p.TranDtls.RegRev, igst_on_intra: p.TranDtls.IgstOnIntra, ecommerce_gstin: '' },
      document_details: { document_type: p.DocDtls.Typ, document_number: p.DocDtls.No, document_date: p.DocDtls.Dt },
      seller_details: party(p.SellerDtls),
      buyer_details: { ...party(p.BuyerDtls), place_of_supply: p.BuyerDtls.Pos },
      ...(p.DispDtls ? { dispatch_details: { company_name: p.DispDtls.Nm, address1: p.DispDtls.Addr1, location: p.DispDtls.Loc, pincode: p.DispDtls.Pin, state_code: STATE_NAMES[p.DispDtls.Stcd] ?? p.DispDtls.Stcd } } : {}),
      ...(p.ShipDtls ? { ship_details: { gstin: p.ShipDtls.Gstin ?? '', legal_name: p.ShipDtls.LglNm, trade_name: p.ShipDtls.LglNm, address1: p.ShipDtls.Addr1, location: p.ShipDtls.Loc, pincode: p.ShipDtls.Pin, state_code: STATE_NAMES[p.ShipDtls.Stcd] ?? p.ShipDtls.Stcd } } : {}),
      ...(p.RefDtls ? { reference_details: { invoice_remarks: '', document_period_details: null, preceding_document_details: p.RefDtls.PrecDocDtls.map((d) => ({ reference_of_original_invoice: d.InvNo, preceding_invoice_date: d.InvDt })) } } : {}),
      value_details: {
        total_assessable_value: p.ValDtls.AssVal, total_cgst_value: p.ValDtls.CgstVal, total_sgst_value: p.ValDtls.SgstVal, total_igst_value: p.ValDtls.IgstVal,
        total_cess_value: 0, total_cess_value_of_state: 0, total_discount: 0, total_other_charge: 0, total_invoice_value: p.ValDtls.TotInvVal, round_off_amount: p.ValDtls.RndOffAmt,
      },
      item_list: p.ItemList.map((it) => ({
        item_serial_number: it.SlNo, product_description: it.PrdDesc, is_service: it.IsServc, hsn_code: it.HsnCd, quantity: it.Qty ?? 0, unit: it.Unit ?? 'OTH',
        unit_price: it.UnitPrice, total_amount: it.TotAmt, discount: 0, other_charge: 0, assessable_value: it.AssAmt, gst_rate: it.GstRt,
        igst_amount: it.IgstAmt, cgst_amount: it.CgstAmt, sgst_amount: it.SgstAmt, cess_rate: 0, cess_amount: 0, cess_nonadvol_amount: 0,
        state_cess_rate: 0, state_cess_amount: 0, state_cess_nonadvol_amount: 0, total_item_value: it.TotItemVal,
      })),
    };
  }
  private irn(m: any): IrnResult {
    return { irn: m.Irn, ackNo: String(m.AckNo), ackDate: portalDate(m.AckDt) ?? new Date(), signedInvoice: m.SignedInvoice, signedQr: m.SignedQRCode, raw: { AckNo: m.AckNo, AckDt: m.AckDt, Irn: m.Irn, Status: m.Status } };
  }

  async testConnection() {
    await this.token(true);
    return { ok: true as const, message: `Masters India ${this.env} accepted the credentials` };
  }
  /** GET /api/v1/get-gstin-details/ → NIC GetGSTINDetails fields (LegalName, TradeName, Addr*, StateCode, AddrPncd, Status). */
  async gstinDetails(gstin: string): Promise<GstinDetails | null> {
    const token = await this.token();
    const qs = new URLSearchParams({ access_token: token, user_gstin: this.gstin, gstin });
    const { json } = await gspFetch(`${this.base}/api/v1/get-gstin-details/?${qs}`, { method: 'GET', headers: { Authorization: `JWT ${token}` } });
    let m: any;
    try { m = this.result(json); } catch (e) { if (e instanceof GspError && /3001|not available/i.test(e.message)) return null; throw e; }
    if (!m || typeof m !== 'object') return null;
    const parts = [m.AddrBno, m.AddrFlno, m.AddrBnm, m.AddrSt].filter((x) => x && String(x).trim());
    return {
      gstin: String(m.Gstin ?? gstin).toUpperCase(), legalName: m.LegalName ?? null, tradeName: m.TradeName ?? null,
      address: parts.length ? parts.join(', ') : null, city: m.AddrLoc ?? null,
      stateCode: m.StateCode != null ? String(m.StateCode).padStart(2, '0') : null, pincode: m.AddrPncd != null ? String(m.AddrPncd) : null,
      status: m.Status ?? null, taxpayerType: m.TxpType ?? null, blocked: m.BlkStatus === 'B',
    };
  }
  async generateIrn(p: IrpPayload) { return this.irn(await this.call('/api/v1/einvoice/', MastersIndiaAdapter.toMastersIndia(p, this.gstin))); }
  async cancelIrn(irn: string, reason: IrnCancelCode, remark: string) {
    const m = await this.call('/api/v1/cancel-einvoice/', { user_gstin: this.gstin, irn, cancel_reason: reason, cancel_remarks: remark });
    return { cancelledAt: portalDate(m?.CancelDate) ?? new Date(), raw: m };
  }
  async getIrnByDocNo(docType: 'INV' | 'CRN' | 'DBN', docNo: string, docDate: string) {
    try { return this.irn(await this.call('/api/v1/get-einvoice-by-document/', { user_gstin: this.gstin, document_type: docType, document_number: docNo, document_date: docDate })); }
    catch { return null; }
  }
  async generateEwbByIrn(i: EwbByIrnInput) {
    const m = await this.call('/api/v1/gen-ewb-by-irn/', {
      user_gstin: this.gstin, irn: i.irn, transporter_id: i.transporterId ?? '', transporter_name: i.transporterName ?? '', transportation_mode: i.transMode,
      transporter_document_number: '', transporter_document_date: i.vehicleNo ? todayIst() : '', vehicle_number: i.vehicleNo ?? '', vehicle_type: i.vehicleType, distance: i.distanceKm, data_source: 'erp',
    });
    return { ewbNo: String(m.EwbNo), ewbDate: portalDate(m.EwbDt) ?? new Date(), validUpto: portalDate(m.EwbValidTill), raw: m };
  }
  async updatePartB(i: PartBInput) {
    const m = await this.call('/api/v1/updateVehicleNumber/', {
      userGstin: this.gstin, eway_bill_number: Number(i.ewbNo), vehicle_number: i.vehicleNo, vehicle_type: 'Regular', place_of_consignor: i.fromPlace, state_of_consignor: STATE_NAMES[i.fromState] ?? i.fromState,
      reason_code_for_vehicle_updation: PARTB_REASON[Number(i.reasonCode)], reason_for_vehicle_updation: i.reasonRemark, transporter_document_number: '', transporter_document_date: todayIst(), mode_of_transport: MODE[Number(i.transMode)], data_source: 'erp',
    });
    return { validUpto: portalDate(m?.validUpto ?? m?.ValidUpto), raw: m };
  }
  async cancelEwb(ewbNo: string, reason: EwbCancelCode, remark: string) {
    const m = await this.call('/api/v1/ewayBillCancel/', { userGstin: this.gstin, eway_bill_number: Number(ewbNo), reason_of_cancel: EWB_CANCEL[Number(reason)], cancel_remark: remark, data_source: 'erp' });
    return { cancelledAt: portalDate(m?.cancelDate ?? m?.CancelDate) ?? new Date(), raw: m };
  }
  async extendValidity(i: ExtendInput) {
    const m = await this.call('/api/v1/ewayBillValidityExtend/', {
      userGstin: this.gstin, eway_bill_number: Number(i.ewbNo), vehicle_number: i.vehicleNo, place_of_consignor: i.fromPlace, state_of_consignor: STATE_NAMES[i.fromState] ?? i.fromState,
      remaining_distance: i.remainingDistanceKm, transporter_document_number: '', transporter_document_date: todayIst(), mode_of_transport: 'Road',
      extend_validity_reason: EXTEND_REASON[i.reasonCode], extend_remarks: i.reasonRemark, from_pincode: i.fromPin, consignment_status: 'M', transit_type: '', address_line1: '', address_line2: '', address_line3: '', data_source: 'erp',
    });
    const v = portalDate(m?.validUpto ?? m?.ValidUpto);
    if (!v) throw new GspError('Masters India did not return a new validity date', undefined, m);
    return { validUpto: v, raw: m };
  }
}
