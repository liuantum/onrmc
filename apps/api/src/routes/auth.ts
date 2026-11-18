import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticate } from '../lib/auth.js';
import { HttpError } from '../lib/errors.js';
import { subscriptionState } from '../lib/subscription.js';

export default async function (app: FastifyInstance) {
  app.post('/login', async (req) => {
    const { phone, password } = z.object({ phone: z.string(), password: z.string() }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { phone }, include: { tenant: true } });
    if (!user || !user.active || !(await bcrypt.compare(password, user.passwordHash))) throw new HttpError(401, 'Invalid phone or password');
    // A super-admin suspension blocks sign-in. A lapsed plan does not: the account opens read-only so the owner can renew.
    if (user.role !== 'SUPER_ADMIN' && !user.tenant?.active) throw new HttpError(403, 'This account has been suspended. Please contact onrmc support.');
    const subscription = user.tenantId ? await subscriptionState(user.tenantId) : null;
    const token = app.jwt.sign({ sub: user.id, tenantId: user.tenantId, role: user.role, name: user.name }, { expiresIn: '12h' });
    return { token, subscription, user: { id: user.id, name: user.name, role: user.role, tenantId: user.tenantId, tenantName: user.tenant?.name } };
  });

  app.get('/me', { preHandler: authenticate }, async (req) => req.user);
}
