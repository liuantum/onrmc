import { portalDate } from './adapters/http.js';

export interface PortalIrn { docNo: string | null; docType: string | null; docDate: string | null; irn: string; ackNo: string; ackDate: Date; signedQr: string | null; signedInvoice: string | null }

const IRN_RE = /^[0-9a-f]{64}$/i;

/** Payload of an IRP-signed JWT (SignedQRCode / SignedInvoice): { data: "<json>" }. Signature is not checked here. */
export function jwtData(token: unknown): Record<string, any> | null {
  if (typeof token !== 'string') return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const body = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return typeof body?.data === 'string' ? JSON.parse(body.data) : body?.data ?? body;
  } catch { return null; }
}

const pick = (o: Record<string, any>, ...names: string[]) => {
  const keys = Object.keys(o);
  for (const n of names) {
    const k = keys.find((x) => x.toLowerCase().replace(/[\s_.]/g, '') === n);
    if (k && o[k] != null && o[k] !== '') return o[k];
  }
  return undefined;
};

/**
 * Reads whatever the e-invoice portal gave back (single response, bulk-upload result, downloaded
 * signed JSON, or an array of those) and returns one row per IRN found. Tolerant of key casing.
 */
export function parsePortalResult(input: unknown): PortalIrn[] {
  const out = new Map<string, PortalIrn>();
  const visit = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, any>;
    const qr = pick(o, 'signedqrcode', 'signedqr');
    const si = pick(o, 'signedinvoice');
    const q = jwtData(qr) ?? {}, s = jwtData(si) ?? {};
    const irn = String(pick(o, 'irn') ?? q.Irn ?? s.Irn ?? '');
    if (IRN_RE.test(irn)) {
      const docNo = pick(o, 'docno', 'documentno', 'documentnumber', 'invno', 'invoiceno') ?? o.DocDtls?.No ?? q.DocNo ?? s.DocDtls?.No ?? null;
      const ackNo = pick(o, 'ackno', 'acknowledgementno', 'acknowledgementnumber') ?? s.AckNo;
      const ackDt = pick(o, 'ackdt', 'ackdate', 'acknowledgementdate') ?? s.AckDt;
      if (ackNo) out.set(irn.toLowerCase(), {
        irn: irn.toLowerCase(), ackNo: String(ackNo), ackDate: portalDate(String(ackDt ?? '')) ?? new Date(),
        docNo: docNo == null ? null : String(docNo).trim(), docType: pick(o, 'doctyp', 'doctype') ?? o.DocDtls?.Typ ?? q.DocTyp ?? s.DocDtls?.Typ ?? null,
        docDate: pick(o, 'docdt', 'docdate') ?? o.DocDtls?.Dt ?? q.DocDt ?? s.DocDtls?.Dt ?? null,
        signedQr: typeof qr === 'string' ? qr : null, signedInvoice: typeof si === 'string' ? si : null,
      });
    }
    for (const x of Object.values(o)) if (x && typeof x === 'object') visit(x);
  };
  visit(input);
  return [...out.values()];
}
