import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@onrmc/shared';

export interface JwtUser { sub: string; tenantId: string | null; role: Role; name: string }

declare module '@fastify/jwt' {
  interface FastifyJWT { payload: JwtUser; user: JwtUser }
}

export async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  try { await req.jwtVerify(); } catch { return reply.code(401).send({ error: 'Unauthorized' }); }
}

/** Route guard. OWNER implicitly passes every tenant-level check. */
export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    await authenticate(req, reply);
    if (reply.sent) return;
    const r = req.user.role;
    const ok = roles.includes(r) || (r === 'OWNER' && !roles.includes('SUPER_ADMIN'));
    if (!ok) return reply.code(403).send({ error: 'Forbidden' });
    if (r !== 'SUPER_ADMIN' && !req.user.tenantId) return reply.code(403).send({ error: 'No tenant' });
  };
}

export const tid = (req: FastifyRequest) => req.user.tenantId as string;
