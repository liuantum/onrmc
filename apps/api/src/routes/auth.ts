import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticate } from '../lib/auth.js';
import { HttpError } from '../lib/errors.js';

export default async function (app: FastifyInstance) {
  app.post('/login', async (req) => {
    const { phone, password } = z.object({ phone: z.string(), password: z.string() }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { phone }, include: { tenant: { include: { subscriptions: { orderBy: { endsAt: 'desc' }, take: 1 } } } } });
    if (!user || !user.active || !(await bcrypt.compare(password, user.passwordHash))) throw new HttpError(401, 'Invalid phone or password');
    if (user.role !== 'SUPER_ADMIN') {
      const sub = user.tenant?.subscriptions[0];
      if (!user.tenant?.active || !sub || !['TRIAL', 'ACTIVE'].includes(sub.status) || sub.endsAt < new Date())
        throw new HttpError(402, 'Subscription inactive. Please contact onrmc support.');
    }
    const token = app.jwt.sign({ sub: user.id, tenantId: user.tenantId, role: user.role, name: user.name }, { expiresIn: '12h' });
    return { token, user: { id: user.id, name: user.name, role: user.role, tenantId: user.tenantId, tenantName: user.tenant?.name } };
  });

  app.get('/me', { preHandler: authenticate }, async (req) => req.user);
}
