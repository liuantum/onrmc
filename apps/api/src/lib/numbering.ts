import { fyLabel } from '@onrmc/shared';
import type { Tx } from './prisma.js';

/** Gap-free, per-tenant, per-financial-year document numbers (row-locked via upsert). */
export async function nextNumber(tx: Tx, tenantId: string, prefix: string, date = new Date()) {
  const key = `${prefix}/${fyLabel(date)}`;
  const s = await tx.numberSeries.upsert({
    where: { tenantId_key: { tenantId, key } },
    create: { tenantId, key, next: 2 },
    update: { next: { increment: 1 } },
  });
  return `${key}/${String(s.next - 1).padStart(4, '0')}`;
}
