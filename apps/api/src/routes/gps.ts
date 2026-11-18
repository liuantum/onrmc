import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { requireRole, tid, type JwtUser } from '../lib/auth.js';
import { bad } from '../lib/errors.js';

const sockets = new Map<string, Set<WebSocket>>();

/** Push an event to every live dashboard of a tenant. */
export function broadcast(tenantId: string, msg: unknown) {
  const s = sockets.get(tenantId);
  if (!s) return;
  const data = JSON.stringify(msg);
  for (const ws of s) if (ws.readyState === 1) ws.send(data);
}

export default async function (app: FastifyInstance) {
  /** Driver app posts a batch of points (works after offline periods too). */
  app.post('/points', { preHandler: requireRole('DRIVER', 'DISPATCH') }, async (req) => {
    const b = z.object({
      vehicleId: z.string(), challanId: z.string().optional(),
      points: z.array(z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), speed: z.number().optional(), heading: z.number().optional(), at: z.coerce.date() })).min(1).max(500),
    }).parse(req.body);
    const t = tid(req);
    const v = await prisma.vehicle.findFirst({ where: { id: b.vehicleId, tenantId: t } });
    if (!v) throw bad('Unknown vehicle');
    await prisma.gpsPoint.createMany({ data: b.points.map((p) => ({ tenantId: t, vehicleId: v.id, challanId: b.challanId, lat: p.lat, lng: p.lng, speed: p.speed, heading: p.heading, recordedAt: p.at })) });
    const last = b.points.reduce((a, p) => (p.at > a.at ? p : a));
    if (!v.lastSeenAt || last.at > v.lastSeenAt) {
      await prisma.vehicle.update({ where: { id: v.id }, data: { lastLat: last.lat, lastLng: last.lng, lastSeenAt: last.at } });
      broadcast(t, { type: 'position', vehicleId: v.id, number: v.number, lat: last.lat, lng: last.lng, speed: last.speed, at: last.at });
    }
    return { ok: true, stored: b.points.length };
  });

  /** Latest position of every truck, with its active trip. */
  app.get('/live', { preHandler: requireRole('MANAGER', 'DISPATCH') }, async (req) =>
    prisma.vehicle.findMany({
      where: { tenantId: tid(req), active: true },
      select: { id: true, number: true, type: true, lastLat: true, lastLng: true, lastSeenAt: true,
        challans: { where: { status: { in: ['LOADED', 'IN_TRANSIT', 'AT_SITE', 'UNLOADING', 'DELIVERED'] } }, take: 1, orderBy: { createdAt: 'desc' }, select: { number: true, status: true, driver: { select: { name: true } }, order: { select: { customer: { select: { name: true } }, site: { select: { name: true, lat: true, lng: true } } } } } } },
    }));

  /** Route trail for one trip. */
  app.get('/trail/:challanId', { preHandler: requireRole('MANAGER', 'DISPATCH') }, async (req) =>
    prisma.gpsPoint.findMany({ where: { tenantId: tid(req), challanId: (req.params as { challanId: string }).challanId }, orderBy: { recordedAt: 'asc' }, select: { lat: true, lng: true, speed: true, recordedAt: true } }));

  /** WebSocket: ws://host/api/gps/ws?token=JWT */
  app.get('/ws', { websocket: true }, (socket, req) => {
    let user: JwtUser;
    try { user = app.jwt.verify<JwtUser>((req.query as { token?: string }).token ?? ''); } catch { socket.close(4401, 'unauthorized'); return; }
    if (!user.tenantId || user.role === 'DRIVER') { socket.close(4403, 'forbidden'); return; }
    const set = sockets.get(user.tenantId) ?? new Set();
    set.add(socket); sockets.set(user.tenantId, set);
    socket.on('close', () => set.delete(socket));
  });
}
