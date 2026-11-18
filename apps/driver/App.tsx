import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Linking, Pressable, RefreshControl, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';

const API = (Constants.expoConfig?.extra as { apiUrl: string }).apiUrl;
const TASK = 'onrmc-trip-location';
const NEXT: Record<string, { label: string; status: string }> = {
  ASSIGNED: { label: 'Loaded at plant', status: 'LOADED' },
  LOADED: { label: 'Start trip', status: 'IN_TRANSIT' },
  IN_TRANSIT: { label: 'Reached site', status: 'AT_SITE' },
  AT_SITE: { label: 'Start unloading', status: 'UNLOADING' },
  UNLOADING: { label: 'Delivered', status: 'DELIVERED' },
  DELIVERED: { label: 'Back at plant', status: 'RETURNED' },
};

async function call(path: string, body?: unknown) {
  const token = await SecureStore.getItemAsync('token');
  const res = await fetch(`${API}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Request failed');
  return data;
}

// Background task: sends GPS points for the active trip. Points that fail are retried with the next batch.
let pending: { lat: number; lng: number; speed?: number; heading?: number; at: string }[] = [];
TaskManager.defineTask(TASK, async ({ data, error }) => {
  if (error) return;
  const { locations } = data as { locations: Location.LocationObject[] };
  pending.push(...locations.map((l) => ({ lat: l.coords.latitude, lng: l.coords.longitude, speed: l.coords.speed ?? undefined, heading: l.coords.heading ?? undefined, at: new Date(l.timestamp).toISOString() })));
  const trip = await SecureStore.getItemAsync('activeTrip');
  if (!trip) return;
  const { vehicleId, challanId } = JSON.parse(trip);
  try { await call('/gps/points', { vehicleId, challanId, points: pending.slice(-500) }); pending = []; } catch { /* offline: keep buffering */ }
});

async function startTracking(vehicleId: string, challanId: string) {
  const fg = await Location.requestForegroundPermissionsAsync();
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (fg.status !== 'granted' || bg.status !== 'granted') { Alert.alert('Location needed', 'Allow "Always" location so dispatch can see your truck during the trip.'); return; }
  await SecureStore.setItemAsync('activeTrip', JSON.stringify({ vehicleId, challanId }));
  if (await Location.hasStartedLocationUpdatesAsync(TASK)) return;
  await Location.startLocationUpdatesAsync(TASK, {
    accuracy: Location.Accuracy.High, timeInterval: 20_000, distanceInterval: 50, deferredUpdatesInterval: 20_000,
    foregroundService: { notificationTitle: 'onrmc trip in progress', notificationBody: 'Sharing truck location with dispatch' },
    pausesUpdatesAutomatically: false, showsBackgroundLocationIndicator: true,
  });
}
async function stopTracking() {
  await SecureStore.deleteItemAsync('activeTrip');
  if (await Location.hasStartedLocationUpdatesAsync(TASK)) await Location.stopLocationUpdatesAsync(TASK);
}

export default function App() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => { SecureStore.getItemAsync('token').then(setToken); }, []);
  if (token === undefined) return <ActivityIndicator style={{ flex: 1 }} />;
  return token ? <Trips onLogout={async () => { await stopTracking(); await SecureStore.deleteItemAsync('token'); setToken(null); }} /> : <Login onDone={setToken} />;
}

function Login({ onDone }: { onDone: (t: string) => void }) {
  const [phone, setPhone] = useState(''); const [password, setPassword] = useState(''); const [busy, setBusy] = useState(false);
  return (
    <SafeAreaView style={s.center}>
      <Text style={s.logo}>onrmc</Text><Text style={s.muted}>Driver</Text>
      <TextInput style={s.input} placeholder="Mobile number" keyboardType="phone-pad" value={phone} onChangeText={setPhone} />
      <TextInput style={s.input} placeholder="Password" secureTextEntry value={password} onChangeText={setPassword} />
      <Pressable style={s.btn} disabled={busy} onPress={async () => {
        setBusy(true);
        try { const r = await call('/auth/login', { phone, password }); await SecureStore.setItemAsync('token', r.token); onDone(r.token); }
        catch (e) { Alert.alert('Sign in failed', (e as Error).message); } finally { setBusy(false); }
      }}><Text style={s.btnText}>{busy ? 'Signing in…' : 'Sign in'}</Text></Pressable>
    </SafeAreaView>
  );
}

function Trips({ onLogout }: { onLogout: () => void }) {
  const [trips, setTrips] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => { setLoading(true); try { setTrips(await call('/driver/trips')); } catch (e) { Alert.alert('Error', (e as Error).message); } finally { setLoading(false); } }, []);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  async function advance(t: any) {
    const n = NEXT[t.status]; if (!n) return;
    try {
      await call(`/driver/trips/${t.id}/status`, { status: n.status });
      if (n.status === 'LOADED' || n.status === 'IN_TRANSIT') await startTracking(t.vehicle.id, t.id);
      if (n.status === 'RETURNED') await stopTracking();
      load();
    } catch (e) { Alert.alert('Error', (e as Error).message); }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#f8fafc' }}>
      <View style={s.header}><Text style={s.title}>My trips</Text><Pressable onPress={onLogout}><Text style={s.muted}>Sign out</Text></Pressable></View>
      <FlatList
        data={trips} keyExtractor={(t) => t.id} contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
        ListEmptyComponent={<Text style={[s.muted, { textAlign: 'center', marginTop: 40 }]}>No trips assigned right now.</Text>}
        renderItem={({ item: t }) => (
          <View style={s.card}>
            <Text style={s.big}>{t.order.mixDesign.grade} · {Number(t.quantityM3)} m³</Text>
            <Text>{t.order.customer.name}</Text>
            <Text style={s.muted}>{t.order.site.name}{t.order.site.address ? ` · ${t.order.site.address}` : ''}</Text>
            <Text style={s.muted}>{t.number} · Truck {t.vehicle.number} · {t.status.replace('_', ' ').toLowerCase()}</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
              {t.order.site.lat && <Pressable style={[s.btn, s.ghost]} onPress={() => Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${t.order.site.lat},${t.order.site.lng}`)}><Text style={[s.btnText, { color: '#1d4ed8' }]}>Navigate</Text></Pressable>}
              {t.order.customer.phone && <Pressable style={[s.btn, s.ghost]} onPress={() => Linking.openURL(`tel:${t.order.customer.phone}`)}><Text style={[s.btnText, { color: '#1d4ed8' }]}>Call site</Text></Pressable>}
              {NEXT[t.status] && <Pressable style={[s.btn, { flex: 1 }]} onPress={() => advance(t)}><Text style={s.btnText}>{NEXT[t.status].label}</Text></Pressable>}
            </View>
          </View>
        )}
      />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: '#fff' },
  logo: { fontSize: 36, fontWeight: '800', color: '#1d4ed8' },
  title: { fontSize: 22, fontWeight: '700' },
  big: { fontSize: 18, fontWeight: '700', marginBottom: 2 },
  muted: { color: '#64748b', marginTop: 2 },
  input: { borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 10, padding: 14, marginTop: 14, fontSize: 16 },
  btn: { backgroundColor: '#1d4ed8', borderRadius: 10, paddingVertical: 14, paddingHorizontal: 16, alignItems: 'center', marginTop: 4 },
  ghost: { backgroundColor: '#eff6ff' },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderColor: '#e2e8f0', backgroundColor: '#fff' },
  card: { backgroundColor: '#fff', borderRadius: 14, padding: 16, borderWidth: 1, borderColor: '#e2e8f0' },
});
