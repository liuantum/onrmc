import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import masterRoutes from './routes/masters.js';
import opsRoutes from './routes/operations.js';
import billingRoutes from './routes/billing.js';
import einvoiceRoutes from './routes/einvoice.js';
import noteRoutes from './routes/notes.js';
import purchaseRoutes from './routes/purchases.js';
import accountRoutes from './routes/accounts.js';
import gpsRoutes from './routes/gps.js';
import analyticsRoutes from './routes/analytics.js';
import fleetRoutes from './routes/fleet.js';
import qcRoutes from './routes/qc.js';
import subscriptionRoutes, { webhookRoutes } from './routes/subscription.js';
import { cachedState, sweepSubscriptions } from './lib/subscription.js';
import type { JwtUser } from './lib/auth.js';

export async function build() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  await app.register(cors, { origin: process.env.CORS_ORIGIN?.split(',') ?? true });
  await app.register(jwt, { secret: process.env.JWT_SECRET ?? 'dev-secret-change-me' });
  await app.register(websocket);

  app.setErrorHandler((err: Error, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'Validation failed', issues: err.issues });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: err.message });
  });

  /**
   * Lapsed plan → read-only. Any write by a tenant user is refused with 402 once the grace period is over,
   * except signing in and paying for the subscription. Reads keep working so nothing is lost.
   */
  const OPEN_WHEN_PAUSED = ['/api/auth/', '/api/subscription/', '/api/webhooks/', '/api/admin/'];
  app.addHook('preHandler', async (req, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || OPEN_WHEN_PAUSED.some((p) => req.url.startsWith(p))) return;
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return;
    let u: JwtUser;
    try { u = app.jwt.verify<JwtUser>(auth.slice(7)); } catch { return; } // the route's own guard answers 401
    if (!u.tenantId || u.role === 'SUPER_ADMIN') return;
    if ((await cachedState(u.tenantId)) === 'PAUSED')
      return reply.code(402).send({ error: 'Your onrmc subscription has lapsed, so the account is read-only. The owner can renew it on the Subscription page.', code: 'SUBSCRIPTION_PAUSED' });
  });

  app.get('/health', async () => ({ ok: true }));
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(masterRoutes, { prefix: '/api' });
  await app.register(opsRoutes, { prefix: '/api' });
  await app.register(billingRoutes, { prefix: '/api' });
  await app.register(einvoiceRoutes, { prefix: '/api' });
  await app.register(noteRoutes, { prefix: '/api' });
  await app.register(purchaseRoutes, { prefix: '/api' });
  await app.register(accountRoutes, { prefix: '/api/accounts' });
  await app.register(gpsRoutes, { prefix: '/api/gps' });
  await app.register(analyticsRoutes, { prefix: '/api/analytics' });
  await app.register(fleetRoutes, { prefix: '/api' });
  await app.register(qcRoutes, { prefix: '/api' });
  await app.register(subscriptionRoutes, { prefix: '/api/subscription' });
  await app.register(webhookRoutes, { prefix: '/api/webhooks' });
  return app;
}

if (process.argv[1]?.includes('server')) {
  const app = await build();
  await app.listen({ port: Number(process.env.PORT ?? 4000), host: '0.0.0.0' });
  const sweep = () => sweepSubscriptions().then((n) => n && app.log.info({ changed: n }, 'subscription sweep')).catch((e) => app.log.error(e, 'subscription sweep failed'));
  sweep();
  setInterval(sweep, 3600e3).unref();
}
