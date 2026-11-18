import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';

const API = (Constants.expoConfig?.extra as { apiUrl: string }).apiUrl;
const inr = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN');

async function call(path: string, body?: unknown) {
  const token = await SecureStore.getItemAsync('token');
  const res = await fetch(`${API}${path}`, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Request failed');
  return data;
}

export default function App() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => { SecureStore.getItemAsync('token').then(setToken); }, []);
  if (token === undefined) return <ActivityIndicator style={{ flex: 1 }} />;
  return token ? <Home onLogout={async () => { await SecureStore.deleteItemAsync('token'); setToken(null); }} /> : <Login onDone={setToken} />;
}

function Login({ onDone }: { onDone: (t: string) => void }) {
  const [phone, setPhone] = useState(''); const [password, setPassword] = useState('');
  return (
    <SafeAreaView style={s.center}>
      <Text style={s.logo}>onrmc</Text><Text style={s.muted}>Owner</Text>
      <TextInput style={s.input} placeholder="Mobile number" keyboardType="phone-pad" value={phone} onChangeText={setPhone} />
      <TextInput style={s.input} placeholder="Password" secureTextEntry value={password} onChangeText={setPassword} />
      <Pressable style={s.btn} onPress={async () => {
        try {
          const r = await call('/auth/login', { phone, password });
          if (r.user.role !== 'OWNER') throw new Error('This app is for plant owners.');
          await SecureStore.setItemAsync('token', r.token); onDone(r.token);
        } catch (e) { Alert.alert('Sign in failed', (e as Error).message); }
      }}><Text style={s.btnText}>Sign in</Text></Pressable>
    </SafeAreaView>
  );
}

function Home({ onLogout }: { onLogout: () => void }) {
  const [d, setD] = useState<any>(null); const [m, setM] = useState<any>(null); const [fleet, setFleet] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try { const [a, b, c] = await Promise.all([call('/analytics/dashboard'), call('/analytics/margin'), call('/gps/live')]); setD(a); setM(b); setFleet(c); }
    catch (e) { Alert.alert('Error', (e as Error).message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);
  const onRoad = fleet.filter((v) => v.challans[0] && v.challans[0].status !== 'DELIVERED');
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#f8fafc' }}>
      <View style={s.header}><Text style={s.title}>Today</Text><Pressable onPress={onLogout}><Text style={s.muted}>Sign out</Text></Pressable></View>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}>
        {d && (
          <View style={s.grid}>
            <Tile k="Produced" v={`${d.today.producedM3} m³`} />
            <Tile k="Delivered" v={`${d.today.deliveredM3} m³`} sub={`${d.today.trips} trips`} />
            <Tile k="Billed" v={inr(d.today.sales)} />
            <Tile k="Collected" v={inr(d.today.collections)} tone="#059669" />
            <Tile k="Receivable" v={inr(d.receivable)} tone="#d97706" />
            <Tile k="Open orders" v={String(d.pendingOrders)} />
          </View>
        )}
        {m && (
          <View style={s.card}>
            <Text style={s.label}>THIS MONTH · PRIVATE</Text>
            <Row k="Revenue (ex-GST)" v={inr(m.totals.revenue)} />
            <Row k="Material + diesel" v={inr(m.totals.cost)} />
            <Row k="Gross margin" v={`${inr(m.totals.margin)} (${m.totals.marginPct.toFixed(1)}%)`} bold />
            <Row k="Cost per m³" v={inr(m.totals.costPerM3)} />
            <Row k="After overheads" v={inr(m.netAfterOverhead)} bold />
          </View>
        )}
        {d?.lowStock.length > 0 && <View style={[s.card, { borderColor: '#fecaca', backgroundColor: '#fef2f2' }]}><Text style={{ color: '#b91c1c', fontWeight: '600' }}>Low stock: {d.lowStock.map((x: any) => x.name).join(', ')}</Text></View>}
        <View style={s.card}>
          <Text style={s.label}>TRUCKS ON ROAD ({onRoad.length})</Text>
          {onRoad.length === 0 && <Text style={s.muted}>None right now</Text>}
          {onRoad.map((v) => <Row key={v.id} k={`${v.number} · ${v.challans[0].order.customer.name}`} v={v.challans[0].status.replace('_', ' ').toLowerCase()} />)}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const Tile = ({ k, v, sub, tone }: { k: string; v: string; sub?: string; tone?: string }) => (
  <View style={[s.card, { width: '48%' }]}><Text style={s.label}>{k.toUpperCase()}</Text><Text style={[s.big, tone ? { color: tone } : null]}>{v}</Text>{sub && <Text style={s.muted}>{sub}</Text>}</View>
);
const Row = ({ k, v, bold }: { k: string; v: string; bold?: boolean }) => (
  <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}><Text style={s.muted}>{k}</Text><Text style={{ fontWeight: bold ? '700' : '500' }}>{v}</Text></View>
);

const s = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: '#fff' },
  logo: { fontSize: 36, fontWeight: '800', color: '#1d4ed8' },
  title: { fontSize: 22, fontWeight: '700' },
  big: { fontSize: 20, fontWeight: '700', marginTop: 4 },
  label: { fontSize: 11, color: '#64748b', fontWeight: '600', letterSpacing: 0.5, marginBottom: 4 },
  muted: { color: '#64748b' },
  input: { borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 10, padding: 14, marginTop: 14, fontSize: 16 },
  btn: { backgroundColor: '#1d4ed8', borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 18 },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderColor: '#e2e8f0', backgroundColor: '#fff' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 12 },
  card: { backgroundColor: '#fff', borderRadius: 14, padding: 16, borderWidth: 1, borderColor: '#e2e8f0' },
});
