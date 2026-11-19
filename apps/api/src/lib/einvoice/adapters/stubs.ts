import { GspError, type GspAdapter } from './types.js';

/**
 * Real GSP adapters. Each needs an account with the provider (sandbox first, then production)
 * and the credentials saved in Settings → E-invoicing.
 *
 * ClearTax → ./cleartax.ts, Masters India → ./mastersindia.ts (both default to the provider's sandbox).
 * TODO(nic-direct): direct IRP/EWB API access needs NIC API credentials (whitelisted IP, client id/secret,
 *   AES session key exchange with NIC's public key). Usually only for large taxpayers — prefer a GSP.
 */
export interface CredentialField { key: string; label: string; optional?: boolean; options?: string[] }
const ENV: CredentialField = { key: 'environment', label: 'Environment', optional: true, options: ['production', 'sandbox'] };
export const CREDENTIAL_FIELDS: Record<string, CredentialField[]> = {
  MOCK: [],
  PORTAL: [],
  CLEARTAX: [ENV, { key: 'authToken', label: 'Auth token' }, { key: 'ownerId', label: 'Owner ID', optional: true }],
  MASTERS_INDIA: [ENV, { key: 'username', label: 'Username' }, { key: 'password', label: 'Password' }, { key: 'clientId', label: 'Client ID', optional: true }, { key: 'clientSecret', label: 'Client secret', optional: true }],
  NIC_DIRECT: [{ key: 'clientId', label: 'Client ID' }, { key: 'clientSecret', label: 'Client secret' }, { key: 'username', label: 'API username' }, { key: 'password', label: 'API password' }],
};

export function missingCredentials(name: string, creds: Record<string, string> | null) {
  const missing = (CREDENTIAL_FIELDS[name] ?? []).filter((f) => !f.optional && !creds?.[f.key]).map((f) => f.label);
  if (missing.length) throw new GspError(`${name} credentials are missing: ${missing.join(', ')}. Add them in Settings → E-invoicing.`, 'NO_CREDENTIALS');
}

export class NotImplementedAdapter implements GspAdapter {
  constructor(readonly name: string, creds: Record<string, string> | null) {
    const missing = (CREDENTIAL_FIELDS[name] ?? []).filter((f) => !f.optional && !creds?.[f.key]).map((f) => f.label);
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
