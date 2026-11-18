import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for GSP credentials at rest. Key comes from EINVOICE_ENC_KEY
 * (any string; hashed to 32 bytes). Format: v1:<iv>:<tag>:<ciphertext>, base64.
 */
function key() {
  const k = process.env.EINVOICE_ENC_KEY;
  if (!k || k.length < 16) throw new Error('EINVOICE_ENC_KEY is not set (min 16 chars) — cannot store or read GSP credentials');
  return createHash('sha256').update(k).digest();
}

export function encryptJson(v: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(v), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decryptJson<T = Record<string, string>>(s: string): T {
  const [ver, iv, tag, ct] = s.split(':');
  if (ver !== 'v1') throw new Error('Unknown credential format');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8'));
}
