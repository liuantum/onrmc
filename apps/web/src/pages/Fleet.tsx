import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MapContainer, Marker, Popup, TileLayer } from 'react-leaflet';
import L from 'leaflet';
import { api, dateTime, session } from '../lib/api';
import { Badge, PageHeader } from '../components/ui';

const truck = (fresh: boolean) => L.divIcon({ className: '', html: `<div style="background:${fresh ? '#1d4ed8' : '#94a3b8'};color:#fff;border-radius:9999px;padding:4px 8px;font:600 11px Inter;box-shadow:0 1px 4px #0004;white-space:nowrap">🚚</div>`, iconSize: [30, 22] });

export default function Fleet() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['live'], queryFn: () => api('/gps/live'), refetchInterval: 60_000 });
  useEffect(() => {
    const s = session.get();
    if (!s) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/gps/ws?token=${s.token}`);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'position') qc.setQueryData(['live'], (old: any[] | undefined) => old?.map((v) => (v.id === m.vehicleId ? { ...v, lastLat: m.lat, lastLng: m.lng, lastSeenAt: m.at } : v)));
      else qc.invalidateQueries({ queryKey: ['live'] });
    };
    return () => ws.close();
  }, [qc]);
  const located = data?.filter((v: any) => v.lastLat) ?? [];
  const center: [number, number] = located[0] ? [located[0].lastLat, located[0].lastLng] : [17.385, 78.4867];
  const fresh = (v: any) => v.lastSeenAt && Date.now() - new Date(v.lastSeenAt).getTime() < 5 * 60_000;
  return (
    <>
      <PageHeader title="Live fleet" subtitle="Positions stream in from the driver app" />
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="card h-[70vh] overflow-hidden">
          <MapContainer center={center} zoom={11} style={{ height: '100%' }}>
            <TileLayer attribution='&copy; OpenStreetMap' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            {located.map((v: any) => (
              <Marker key={v.id} position={[v.lastLat, v.lastLng]} icon={truck(fresh(v))}>
                <Popup><b>{v.number}</b><br />{v.challans[0] ? `${v.challans[0].number} → ${v.challans[0].order.site.name}` : 'Idle'}<br />{dateTime(v.lastSeenAt)}</Popup>
              </Marker>
            ))}
          </MapContainer>
        </div>
        <div className="space-y-2">
          {data?.map((v: any) => (
            <div key={v.id} className="card p-3">
              <div className="flex items-center justify-between"><span className="font-semibold">{v.number}</span>{v.challans[0] ? <Badge s={v.challans[0].status} /> : <span className="text-xs text-slate-400">idle</span>}</div>
              {v.challans[0] && <div className="text-sm text-slate-600">{v.challans[0].order.customer.name} · {v.challans[0].driver?.name}</div>}
              <div className="text-xs text-slate-400">{v.lastSeenAt ? `Last seen ${dateTime(v.lastSeenAt)}` : 'No GPS yet'}</div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
