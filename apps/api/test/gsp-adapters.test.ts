import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClearTaxAdapter } from '../src/lib/einvoice/adapters/cleartax.js';
import { MastersIndiaAdapter } from '../src/lib/einvoice/adapters/mastersindia.js';
import { GspError } from '../src/lib/einvoice/adapters/types.js';
import { portalDate } from '../src/lib/einvoice/adapters/http.js';
import type { IrpPayload } from '../src/lib/einvoice/payload.js';

const payload: IrpPayload = {
  Version: '1.1', TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', EcmGstin: null, IgstOnIntra: 'N' },
  DocDtls: { Typ: 'INV', No: 'INV/26-27/0001', Dt: '18/11/2026' },
  SellerDtls: { Gstin: '36AABCU9603R1ZM', LglNm: 'Demo RMC', Addr1: 'Plot 1', Loc: 'Hyderabad', Pin: 500032, Stcd: '36' },
  BuyerDtls: { Gstin: '36AAACR5055K1Z5', LglNm: 'Buyer', Pos: '36', Addr1: 'Site', Loc: 'Hyderabad', Pin: 500081, Stcd: '36' },
  ItemList: [{ SlNo: '1', PrdDesc: 'M25', IsServc: 'N', HsnCd: '38245010', Qty: 6, Unit: 'CBM', UnitPrice: 5000, TotAmt: 30000, Discount: 0, AssAmt: 30000, GstRt: 18, IgstAmt: 0, CgstAmt: 2700, SgstAmt: 2700, CesRt: 0, CesAmt: 0, CesNonAdvlAmt: 0, StateCesRt: 0, StateCesAmt: 0, StateCesNonAdvlAmt: 0, OthChrg: 0, TotItemVal: 35400 }],
  ValDtls: { AssVal: 30000, CgstVal: 2700, SgstVal: 2700, IgstVal: 0, CesVal: 0, StCesVal: 0, Discount: 0, OthChrg: 0, RndOffAmt: 0, TotInvVal: 35400 },
};

type Call = { url: string; method: string; headers: Record<string, string>; body: any };
function fakeFetch(handler: (c: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const c = { url, method: init.method!, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const r = handler(c);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return calls;
}

test('portal dates are read as IST', () => {
  assert.equal(portalDate('18/11/2026 10:30:00')!.toISOString(), '2026-11-18T05:00:00.000Z');
  assert.equal(portalDate('2026-11-18 10:30:00')!.toISOString(), '2026-11-18T05:00:00.000Z');
  assert.equal(portalDate('19/11/2026 11:59:00 PM')!.toISOString(), '2026-11-19T18:29:00.000Z');
});

test('ClearTax: sandbox URL, auth headers, NIC payload wrapped, govt_response read', async () => {
  const calls = fakeFetch(() => ({ body: [{ govt_response: { Success: 'Y', AckNo: 112010000001, AckDt: '2026-11-18 10:30:00', Irn: 'a'.repeat(64), SignedInvoice: 'x.y.z', SignedQRCode: 'q.r.s' } }] }));
  const a = new ClearTaxAdapter({ authToken: 'tok', ownerId: 'own' }, '36AABCU9603R1ZM', 'sandbox');
  const r = await a.generateIrn(payload);
  assert.equal(calls[0].url, 'https://api-sandbox.clear.in/einv/v2/eInvoice/generate');
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].headers['X-Cleartax-Auth-Token'], 'tok');
  assert.equal(calls[0].headers.gstin, '36AABCU9603R1ZM');
  assert.deepEqual(calls[0].body, [{ transaction: payload }]); // amounts are sent untouched
  assert.equal(r.irn, 'a'.repeat(64));
  assert.equal(r.ackNo, '112010000001');
});

test('ClearTax: portal error keeps the IRP code (2150 → duplicate handling)', async () => {
  fakeFetch(() => ({ body: [{ govt_response: { Success: 'N', ErrorDetails: [{ error_code: '2150', error_message: 'Duplicate IRN' }] } }] }));
  const a = new ClearTaxAdapter({ authToken: 'tok' }, '36AABCU9603R1ZM', 'production');
  await assert.rejects(a.generateIrn(payload), (e: GspError) => e.code === '2150' && /Duplicate/.test(e.message));
});

test('ClearTax: 401 becomes an AUTH error', async () => {
  fakeFetch(() => ({ status: 401, body: { error: 'unauthorized' } }));
  await assert.rejects(new ClearTaxAdapter({ authToken: 'bad' }, '36AABCU9603R1ZM', 'sandbox').testConnection(), (e: GspError) => e.code === 'AUTH');
});

test('Masters India: token, JWT header, mapped amounts equal NIC payload', async () => {
  const calls = fakeFetch((c) => c.url.endsWith('/token-auth/') ? { body: { token: 'jwt1' } } : { body: { results: { status: 'Success', code: 200, message: { AckNo: 1, AckDt: '2026-11-18 10:30:00', Irn: 'b'.repeat(64), SignedInvoice: 's', SignedQRCode: 'q' } } } });
  const a = new MastersIndiaAdapter({ username: 'u-mi-1', password: 'p' }, '36AABCU9603R1ZM', 'sandbox');
  const r = await a.generateIrn(payload);
  assert.equal(calls[0].url, 'https://sandb-api.mastersindia.co/api/v1/token-auth/');
  const call = calls[1];
  assert.equal(call.headers.Authorization, 'JWT jwt1');
  assert.equal(call.body.access_token, 'jwt1');
  assert.equal(call.body.value_details.total_invoice_value, 35400);
  assert.equal(call.body.value_details.total_cgst_value, 2700);
  assert.equal(call.body.item_list[0].assessable_value, 30000);
  assert.equal(call.body.item_list[0].hsn_code, '38245010');
  assert.equal(call.body.seller_details.state_code, 'TELANGANA');
  assert.equal(r.irn, 'b'.repeat(64));
});

test('Masters India: duplicate message maps to 2150; expired token is refreshed once', async () => {
  let n = 0;
  const calls = fakeFetch((c) => {
    if (c.url.endsWith('/token-auth/')) return { body: { token: `jwt${++n}` } };
    if (c.headers.Authorization === 'JWT jwt1') return { status: 401, body: { detail: 'expired' } };
    return { body: { results: { status: 'Failed', errorMessage: '2150: Duplicate IRN', code: 204 } } };
  });
  const a = new MastersIndiaAdapter({ username: 'u-mi-2', password: 'p' }, '36AABCU9603R1ZM', 'sandbox');
  await assert.rejects(a.generateIrn(payload), (e: GspError) => e.code === '2150');
  assert.equal(calls.filter((c) => c.url.endsWith('/token-auth/')).length, 2);
});

test('Masters India: GSTIN details read from the NIC fields; "not available" is null', async () => {
  const calls = fakeFetch((c) => {
    if (c.url.endsWith('/token-auth/')) return { body: { token: 'jwt9' } };
    if (c.url.includes('gstin=36AAACS1234K1ZI')) return { body: { results: { message: { Gstin: '36AAACS1234K1ZI', LegalName: 'SRI CONSTRUCTIONS PVT LTD', TradeName: 'Sri Constructions', AddrBno: '4-1', AddrBnm: 'Cyber Towers', AddrFlno: '4th Floor', AddrSt: 'Madhapur', AddrLoc: 'Hyderabad', StateCode: 36, AddrPncd: 500081, TxpType: 'REG', Status: 'ACT', BlkStatus: 'U' }, errorMessage: '', status: 'Success', code: 200 } } };
    return { body: { results: { message: '', errorMessage: '3001: Requested data is not available', status: 'Failed', code: 204 } } };
  });
  const a = new MastersIndiaAdapter({ username: 'u-mi-3', password: 'p' }, '36AABCU9603R1ZM', 'production');
  const d = await a.gstinDetails('36AAACS1234K1ZI');
  const get = calls.find((c) => c.url.includes('/get-gstin-details/'))!;
  assert.equal(get.method, 'GET');
  assert.ok(get.url.startsWith('https://prod-api.mastersindia.co/api/v1/get-gstin-details/?'));
  assert.ok(get.url.includes('user_gstin=36AABCU9603R1ZM'));
  assert.equal(get.headers.Authorization, 'JWT jwt9');
  assert.deepEqual(d, { gstin: '36AAACS1234K1ZI', legalName: 'SRI CONSTRUCTIONS PVT LTD', tradeName: 'Sri Constructions', address: '4-1, 4th Floor, Cyber Towers, Madhapur', city: 'Hyderabad', stateCode: '36', pincode: '500081', status: 'ACT', taxpayerType: 'REG', blocked: false });
  assert.equal(await a.gstinDetails('29AAACS1234K1ZE'), null);
});

test('portal result: IRN rows found in nested / signed-QR shaped JSON', async () => {
  const { parsePortalResult } = await import('../src/lib/einvoice/portal-import.js');
  const irn = 'a'.repeat(64);
  const qr = `h.${Buffer.from(JSON.stringify({ data: JSON.stringify({ DocNo: 'INV/26-27/0009', DocTyp: 'INV', Irn: irn }) })).toString('base64url')}.s`;
  const rows = parsePortalResult({ Status: 1, Data: { AckNo: 182610000000001, AckDt: '19/11/2026 10:15:00', Irn: irn.toUpperCase(), SignedQRCode: qr } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].docNo, 'INV/26-27/0009');
  assert.equal(rows[0].irn, irn);
  assert.equal(rows[0].ackNo, '182610000000001');
  assert.equal(rows[0].ackDate.toISOString(), '2026-11-19T04:45:00.000Z');
  assert.equal(parsePortalResult([{ 'Ack No': '1', 'IRN': irn, 'Doc No': 'X1' }, { foo: 1 }])[0].docNo, 'X1');
  assert.equal(parsePortalResult({ Irn: 'short', AckNo: 1 }).length, 0);
});

test('GST portal search answer → name, address, PIN, state code, status', async () => {
  const { parsePortalTaxpayer } = await import('../src/lib/gst-portal.js');
  const d = parsePortalTaxpayer({
    gstin: '36AAACS1234K1ZI', lgnm: 'SRI CONSTRUCTIONS PRIVATE LIMITED', tradeNam: 'SRI CONSTRUCTIONS', sts: 'Active', dty: 'Regular', ctb: 'Private Limited Company',
    pradr: { addr: { bno: '4-1', flno: '4th Floor', bnm: 'Cyber Towers', st: 'Madhapur', loc: 'Hyderabad', dst: 'Hyderabad', stcd: 'Telangana', pncd: '500081', lt: '', lg: '' }, ntr: 'Supplier of Services' },
  }, '36AAACS1234K1ZI')!;
  assert.equal(d.legalName, 'SRI CONSTRUCTIONS PRIVATE LIMITED');
  assert.equal(d.address, '4-1, 4th Floor, Cyber Towers, Madhapur');
  assert.equal(d.city, 'Hyderabad');
  assert.equal(d.pincode, '500081');
  assert.equal(d.stateCode, '36');
  assert.equal(d.status, 'ACT');
  assert.equal(parsePortalTaxpayer({ sts: 'Cancelled', lgnm: 'X', pradr: { adr: 'Plot 9, Bengaluru, Karnataka, 560001' } }, '29AAACS1234K1ZE')!.pincode, '560001');
  assert.equal(parsePortalTaxpayer({ errorCode: 'FO8000' }, '29AAACS1234K1ZE'), null);
});

test('Cashfree Verify GSTIN: URL, key headers, answer mapped; unknown GSTIN is null; empty balance explained', async () => {
  const { cashfreeGstin } = await import('../src/lib/cashfree-gstin.js');
  const calls = fakeFetch((c) => {
    if (c.body.GSTIN === '29AAICP2912R1ZR') return { body: { reference_id: 19, GSTIN: '29AAICP2912R1ZR', legal_name_of_business: 'UJJIVAN SMALL FINANCE BANK LIMITED', trade_name_of_business: 'UJJIVAN SMALL FINANCE BANK', gst_in_status: 'Active', taxpayer_type: 'Regular', principal_place_address: 'Grape Garden, 18th Main, Koramangala, Bengaluru, Karnataka, 560095', principal_place_split_address: { building_name: 'Grape Garden', street: '18th Main', location: 'Koramangala', building_number: 'No 27', district: 'Bengaluru Urban', state: 'Karnataka', city: 'Bengaluru', flat_number: '', pincode: '560095' }, valid: true, message: 'GSTIN Exists' } };
    if (c.body.GSTIN === '22ABCDE1234F1Z5') return { body: { reference_id: 20, GSTIN: '22ABCDE1234F1Z5', message: "GSTIN Doesn't Exist" } };
    return { status: 422, body: { type: 'validation_error', code: 'insufficient_balance', message: 'low' } };
  });
  const d = await cashfreeGstin({ clientId: 'cid', clientSecret: 'sec' }, 'production', '29AAICP2912R1ZR');
  assert.equal(calls[0].url, 'https://api.cashfree.com/verification/gstin');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers['x-client-id'], 'cid');
  assert.equal(calls[0].headers['x-client-secret'], 'sec');
  assert.deepEqual(d, { gstin: '29AAICP2912R1ZR', legalName: 'UJJIVAN SMALL FINANCE BANK LIMITED', tradeName: 'UJJIVAN SMALL FINANCE BANK', address: 'No 27, Grape Garden, 18th Main, Koramangala', city: 'Bengaluru', stateCode: '29', pincode: '560095', status: 'ACT', taxpayerType: 'Regular', blocked: false });
  assert.equal(await cashfreeGstin({ clientId: 'cid', clientSecret: 'sec' }, 'sandbox', '22ABCDE1234F1Z5'), null);
  assert.equal(calls[1].url, 'https://sandbox.cashfree.com/verification/gstin');
  await assert.rejects(cashfreeGstin({ clientId: 'cid', clientSecret: 'sec' }, 'production', '36AABCU9603R1ZO'), (e: GspError) => /balance/.test(e.message));
});
