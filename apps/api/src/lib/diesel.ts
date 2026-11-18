import { num, type Tx } from './prisma.js';
import { accountId, post } from './ledger.js';

/**
 * Keeps the books in step with the diesel recorded on a challan: Dr Diesel / Fuel expense (5100), Cr Cash (1100).
 * On a change the previous posting is reversed and the new amount posted; a cancelled challan ends at zero.
 */
export async function syncChallanDiesel(tx: Tx, tenantId: string, challan: { id: string; number: string; dieselCost: unknown; status: string }) {
  const want = challan.status === 'CANCELLED' ? 0 : Math.round(num(challan.dieselCost as never) * 100) / 100;
  const fuel = await accountId(tx, tenantId, '5100');
  const posted = await tx.journalEntry.aggregate({
    where: { accountId: fuel, journal: { tenantId, sourceId: challan.id, sourceType: { in: ['CHALLAN_DIESEL', 'CHALLAN_DIESEL_REV'] } } },
    _sum: { debit: true, credit: true },
  });
  const have = Math.round((num(posted._sum.debit) - num(posted._sum.credit)) * 100) / 100;
  if (have === want) return;
  const cash = await accountId(tx, tenantId, '1100');
  if (have !== 0) {
    await post(tx, tenantId, `Diesel reversed ${challan.number}${challan.status === 'CANCELLED' ? ' (challan cancelled)' : ' (amended)'}`, 'CHALLAN_DIESEL_REV', challan.id, [
      { accountId: cash, debit: have }, { accountId: fuel, credit: have },
    ]);
  }
  if (want !== 0) {
    await post(tx, tenantId, `Diesel ${challan.number}`, 'CHALLAN_DIESEL', challan.id, [
      { accountId: fuel, debit: want }, { accountId: cash, credit: want },
    ]);
  }
}
