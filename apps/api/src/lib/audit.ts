import type { FastifyRequest } from 'fastify';
import { prisma, type Tx } from './prisma.js';

export function audit(req: FastifyRequest, action: string, entity: string, entityId?: string, data?: unknown, tx: Tx = prisma) {
  return tx.auditLog.create({
    data: {
      tenantId: req.user?.tenantId ?? null, userId: req.user?.sub ?? null,
      action, entity, entityId, data: data as object | undefined,
    },
  });
}
