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
  return app;
}

if (process.argv[1]?.includes('server')) {
  const app = await build();
  await app.listen({ port: Number(process.env.PORT ?? 4000), host: '0.0.0.0' });
}
