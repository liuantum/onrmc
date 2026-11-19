import { GspError, type GspAdapter } from './types.js';

/**
 * "GST portal" mode: no GSP account. onrmc builds the NIC-schema JSON, the user uploads it at
 * https://einvoice1.gst.gov.in with their own GST login, and imports the IRN result back.
 * Cancellations and vehicle changes done on the portal are recorded here for the books.
 */
export class PortalAdapter implements GspAdapter {
  readonly name = 'PORTAL';
  private upload(what: string): never {
    throw new GspError(`${what} is done on the GST portal in this mode. Download the JSON from this invoice, upload it at einvoice1.gst.gov.in, then import the result back into onrmc.`, 'PORTAL');
  }
  async testConnection() { return { ok: true as const, message: 'GST portal mode: no GSP account needed. Download JSON from an invoice, upload it at einvoice1.gst.gov.in, then import the IRN result.' }; }
  generateIrn(): never { return this.upload('IRN generation'); }
  async getIrnByDocNo() { return null; }
  generateEwbByIrn(): never { throw new GspError('Generate the e-way bill on ewaybillgst.gov.in (or from the IRN on the e-invoice portal), then enter its number here.', 'PORTAL'); }
  /** The user has already done these on the portal; we only record them. */
  async cancelIrn() { return { cancelledAt: new Date() }; }
  async updatePartB() { return { validUpto: null }; }
  async cancelEwb() { return { cancelledAt: new Date() }; }
  extendValidity(): never { throw new GspError('Extend the e-way bill on ewaybillgst.gov.in, then enter the new validity here.', 'PORTAL'); }
}
