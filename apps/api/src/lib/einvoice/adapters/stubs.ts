import { GspError, type GspAdapter } from './types.js';

/**
 * Real GSP adapters. Each needs an account with the provider (sandbox first, then production)
 * and the credentials saved in Settings → E-invoicing.
 *
 * TODO(cleartax): implement against ClearTax GSP e-invoice API v2 — auth with X-Cleartax-Auth-Token
 *   + gstin header; PUT /einv/v2/eInvoice/generate, /einv/v2/eInvoice/cancel, /einv/v2/eInvoice/ewaybill,
 *   /einv/v1/ewaybill/update?action=PARTB, CANCEL, EXTEND.
 * TODO(masters-india): implement against Masters India e-invoice API — POST /api/v1/token-auth/ for an access
 *   token (username/password/client_id/client_secret), then /api/v1/einvoice/, /api/v1/cancel-einvoice/,
 *   /api/v1/gen-ewb-by-irn/, /api/v1/update-vehicle-number/, /api/v1/ewayBillCancel/, /api/v1/ewayBillValidityExtend/.
 * TODO(nic-direct): direct IRP/EWB API access needs NIC API credentials (whitelisted IP, client id/secret,
 *   AES session key exchange with NIC's public key). Usually only for large taxpayers — prefer a GSP.
 */
export const CREDENTIAL_FIELDS: Record<string, { key: string; label: string }[]> = {
  MOCK: [],
  CLEARTAX: [{ key: 'authToken', label: 'Auth token' }, { key: 'ownerId', label: 'Owner ID' }],
  MASTERS_INDIA: [{ key: 'username', label: 'Username' }, { key: 'password', label: 'Password' }, { key: 'clientId', label: 'Client ID' }, { key: 'clientSecret', label: 'Client secret' }],
  NIC_DIRECT: [{ key: 'clientId', label: 'Client ID' }, { key: 'clientSecret', label: 'Client secret' }, { key: 'username', label: 'API username' }, { key: 'password', label: 'API password' }],
};

export class NotImplementedAdapter implements GspAdapter {
  constructor(readonly name: string, creds: Record<string, string> | null) {
    const missing = (CREDENTIAL_FIELDS[name] ?? []).filter((f) => !creds?.[f.key]).map((f) => f.label);
    if (missing.length) throw new GspError(`${name} credentials are missing: ${missing.join(', ')}. Add them in Settings → E-invoicing.`, 'NO_CREDENTIALS');
  }
  private no(): never {
    throw new GspError(`${this.name} integration is not built yet. Use the MOCK provider for testing, or ask for this provider to be connected.`, 'NOT_IMPLEMENTED');
  }
  testConnection() { return this.no(); }
  generateIrn() { return this.no(); }
  cancelIrn() { return this.no(); }
  getIrnByDocNo() { return this.no(); }
  generateEwbByIrn() { return this.no(); }
  updatePartB() { return this.no(); }
  cancelEwb() { return this.no(); }
  extendValidity() { return this.no(); }
}
