import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { SYSTEM_ACCOUNTS } from '../src/lib/ledger.js';

const prisma = new PrismaClient();

// Check-digit-valid dummy GSTINs (Telangana, 36) for the demo company and customer.
const DEMO_GSTIN = '36ABCDE1234F1Z1';
const CUSTOMER_GSTIN = '36AAACS1234K1ZI';

/** Demo tenant: e-invoice + e-way bill on, MOCK provider (offline), and the PINs/addresses the IRP needs. */
async function demoEinvoice(tenantId: string) {
  await prisma.einvoiceSettings.upsert({ where: { tenantId }, update: {}, create: { tenantId, einvoiceEnabled: true, ewaybillEnabled: true, provider: 'MOCK' } });
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  if (!t.pincode) await prisma.tenant.update({ where: { id: tenantId }, data: { gstin: DEMO_GSTIN, address: 'Plot 12, IDA Uppal, Hyderabad, Telangana', city: 'Hyderabad', pincode: '500039' } });
  await prisma.plant.updateMany({ where: { tenantId, pincode: null }, data: { address: 'Plot 12, IDA Uppal, Hyderabad', pincode: '500039' } });
  await prisma.customer.updateMany({ where: { tenantId, name: 'Sri Constructions', pincode: null }, data: { gstin: CUSTOMER_GSTIN, billingAddress: '4th Floor, Cyber Towers, Madhapur, Hyderabad', city: 'Hyderabad', pincode: '500081' } });
  await prisma.site.updateMany({ where: { tenantId, name: 'Gachibowli Tower B', pincode: null }, data: { address: 'Tower B, Financial District, Gachibowli', city: 'Hyderabad', pincode: '500032' } });
}

async function main() {
  const hash = (p: string) => bcrypt.hash(p, 10);
  await prisma.user.upsert({ where: { phone: '9000000000' }, update: {}, create: { name: 'onrmc Admin', phone: '9000000000', role: 'SUPER_ADMIN', passwordHash: await hash('admin@123') } });

  const plans = [
    { name: 'Starter', priceMonthly: 2999, priceYearly: 29990, maxPlants: 1, maxUsers: 10, maxVehicles: 10, features: ['billing', 'accounts'] },
    { name: 'Professional', priceMonthly: 6999, priceYearly: 69990, maxPlants: 2, maxUsers: 30, maxVehicles: 30, features: ['billing', 'accounts', 'gps', 'owner_app', 'analytics'] },
    { name: 'Enterprise', priceMonthly: 14999, priceYearly: 149990, maxPlants: 10, maxUsers: 200, maxVehicles: 200, features: ['billing', 'accounts', 'gps', 'owner_app', 'analytics', 'api'] },
  ];
  for (const p of plans) await prisma.plan.upsert({ where: { name: p.name }, update: p, create: p });
  const pro = await prisma.plan.findUniqueOrThrow({ where: { name: 'Professional' } });

  const existing = await prisma.user.findUnique({ where: { phone: '9111111111' } });
  if (existing?.tenantId) { await demoEinvoice(existing.tenantId); console.log('Demo tenant exists — e-invoice demo data refreshed.'); return; }
  const t = await prisma.tenant.create({ data: { name: 'Demo Readymix', legalName: 'Demo Readymix Pvt Ltd', gstin: DEMO_GSTIN, stateCode: '36', address: 'Plot 12, IDA Uppal, Hyderabad, Telangana', city: 'Hyderabad', pincode: '500039', phone: '9111111111' } });
  await prisma.subscription.create({ data: { tenantId: t.id, planId: pro.id, status: 'ACTIVE', endsAt: new Date(Date.now() + 365 * 864e5) } });
  await prisma.account.createMany({ data: SYSTEM_ACCOUNTS.map((a) => ({ ...a, tenantId: t.id, system: true })) });
  const plant = await prisma.plant.create({ data: { tenantId: t.id, name: 'Main Plant', address: 'Plot 12, IDA Uppal, Hyderabad', pincode: '500039', lat: 17.385, lng: 78.4867 } });
  const users: [string, string, string][] = [
    ['Owner', '9111111111', 'OWNER'], ['Manager', '9222222222', 'MANAGER'], ['Accountant', '9333333333', 'ACCOUNTANT'],
    ['Store', '9444444444', 'STORE'], ['Batching', '9555555555', 'BATCHING'], ['Dispatch', '9666666666', 'DISPATCH'], ['Ravi (Driver)', '9777777777', 'DRIVER'],
  ];
  for (const [name, phone, role] of users) await prisma.user.create({ data: { tenantId: t.id, name, phone, role: role as never, plantId: plant.id, passwordHash: await hash('demo@123') } });

  const mats = [
    ['OPC 53 Cement', 'CEMENT', 'KG', 7.2], ['Fly Ash', 'FLY_ASH', 'KG', 1.6], ['20mm Aggregate', 'AGGREGATE_20MM', 'KG', 0.95],
    ['10mm Aggregate', 'AGGREGATE_10MM', 'KG', 0.98], ['M-Sand', 'M_SAND', 'KG', 0.85], ['Admixture', 'ADMIXTURE', 'KG', 55], ['Water', 'WATER', 'LTR', 0.05],
  ] as const;
  const m: Record<string, string> = {};
  let openingValue = 0;
  for (const [name, kind, unit, cost] of mats) {
    const x = await prisma.material.create({ data: { tenantId: t.id, name, kind, unit, avgCost: cost, reorderLevel: kind === 'CEMENT' ? 20000 : 0 } });
    await prisma.stock.create({ data: { tenantId: t.id, plantId: plant.id, materialId: x.id, quantity: kind === 'WATER' ? 100000 : 200000 } });
    m[kind] = x.id;
    openingValue += (kind === 'WATER' ? 100000 : 200000) * cost;
  }
  // Opening stock in the books: Dr Inventory / Cr Capital, so the ledger equals the stock valuation.
  const accId = async (code: string) => (await prisma.account.findUniqueOrThrow({ where: { tenantId_code: { tenantId: t.id, code } } })).id;
  openingValue = Math.round(openingValue * 100) / 100;
  await prisma.journal.create({ data: { tenantId: t.id, narration: 'Opening stock', sourceType: 'OPENING_STOCK', entries: { create: [
    { accountId: await accId('1400'), debit: openingValue }, { accountId: await accId('3000'), credit: openingValue },
  ] } } });
  const mix = (grade: string, rate: number, cement: number, fa: number) => prisma.mixDesign.create({ data: {
    tenantId: t.id, grade, name: `${grade} Standard`, baseRate: rate, gstRate: 18,
    items: { create: [
      { materialId: m.CEMENT, qtyPerM3: cement }, { materialId: m.FLY_ASH, qtyPerM3: fa }, { materialId: m.AGGREGATE_20MM, qtyPerM3: 700 },
      { materialId: m.AGGREGATE_10MM, qtyPerM3: 450 }, { materialId: m.M_SAND, qtyPerM3: 800 }, { materialId: m.ADMIXTURE, qtyPerM3: 3 }, { materialId: m.WATER, qtyPerM3: 165 },
    ] } } });
  await mix('M20', 4300, 260, 80); await mix('M25', 4700, 300, 90); await mix('M30', 5200, 340, 100);

  const acc = await prisma.account.create({ data: { tenantId: t.id, code: '130001', name: 'Sri Constructions', type: 'ASSET', group: 'Sundry Debtors' } });
  const cust = await prisma.customer.create({ data: { tenantId: t.id, name: 'Sri Constructions', gstin: CUSTOMER_GSTIN, stateCode: '36', phone: '9888888888', billingAddress: '4th Floor, Cyber Towers, Madhapur, Hyderabad', city: 'Hyderabad', pincode: '500081', creditDays: 30, creditLimit: 500000, accountId: acc.id } });
  await prisma.site.create({ data: { tenantId: t.id, customerId: cust.id, name: 'Gachibowli Tower B', address: 'Tower B, Financial District, Gachibowli', city: 'Hyderabad', pincode: '500032', stateCode: '36', lat: 17.44, lng: 78.35 } });
  for (const n of ['TS09UA1234', 'TS09UA5678', 'TS09UB1111']) await prisma.vehicle.create({ data: { tenantId: t.id, number: n, capacityM3: 7 } });
  const sup = await prisma.account.create({ data: { tenantId: t.id, code: '210001', name: 'Ultra Cement Depot', type: 'LIABILITY', group: 'Sundry Creditors' } });
  await prisma.supplier.create({ data: { tenantId: t.id, name: 'Ultra Cement Depot', stateCode: '36', paymentTermsDays: 30, accountId: sup.id } });
  await demoEinvoice(t.id);
  console.log('Seeded. Super admin 9000000000 / admin@123 · Owner 9111111111 / demo@123');
}
main().finally(() => prisma.$disconnect());
