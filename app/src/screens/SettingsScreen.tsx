import React, { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useGps } from '../context/GpsContext';
import { getAccSettings, setAccSettings } from '../services/storage';
import { C } from '../theme';

const NTRIP_PRESETS = [
  { name: 'MABAT Israel (free)', host: 'ntrip.survey.gov.il', port: '2101', mnt: '' },
  { name: 'RTK2go (free)',       host: 'rtk2go.com',          port: '2101', mnt: '' },
  { name: 'IGS (global)',        host: 'ntrip.igs-ip.net',    port: '2101', mnt: '' },
];

export default function SettingsScreen() {
  const { gps, bleStatus, sendCmd, sendNtripConfig, syncFromDevice, deleteAllWaypoints } = useGps();

  const [host, setHost] = useState('');
  const [port, setPort] = useState('2101');
  const [mnt,  setMnt]  = useState('');
  const [usr,  setUsr]  = useState('');
  const [pwd,  setPwd]  = useState('');
  const [minAcc,      setMinAccState]   = useState('0');
  const [maxAcc,      setMaxAccState]   = useState('10');
  const [antennaH,    setAntennaH]      = useState('0.000');

  useEffect(() => {
    getAccSettings().then(({ minAcc, maxAcc }) => {
      setMinAccState(String(minAcc));
      setMaxAccState(String(maxAcc));
    });
  }, []);

  // Sync antenna height from device once connected
  useEffect(() => {
    if (gps?.cfg?.ant_h != null) {
      setAntennaH(gps.cfg.ant_h.toFixed(3));
    }
  }, [gps?.cfg?.ant_h]);

  const bleBadge = bleStatus === 'connected'
    ? { bg: C.green,  text: 'Connected to GPS-Survey' }
    : bleStatus === 'connecting'
    ? { bg: C.amber,  text: 'Scanning…' }
    : { bg: C.red,    text: 'Not connected' };

  const saveNtripToDevice = () => {
    if (!host || !mnt) {
      Alert.alert('Missing fields', 'Fill in Host and Mount point.');
      return;
    }
    sendNtripConfig({ host, port, mnt, usr, pwd });
    Alert.alert('Sent', 'NTRIP config sent to device.');
  };

  const saveAntennaHeight = () => {
    const h = parseFloat(antennaH) || 0;
    setAntennaH(h.toFixed(3));
    sendCmd({ cmd: 'cfg', ant_h: h });
    Alert.alert('Saved', `Antenna height set to ${h.toFixed(3)} m`);
  };

  const saveAcc = async () => {
    const mn = parseFloat(minAcc) || 0;
    const mx = parseFloat(maxAcc) || 10;
    await setAccSettings(mn, mx);
    Alert.alert('Saved', 'Accuracy filter updated.');
  };

  const handleSync = () => {
    if (bleStatus !== 'connected') {
      Alert.alert('Not connected', 'Connect to the GPS device first.');
      return;
    }
    syncFromDevice();
    Alert.alert('Syncing', 'Requesting waypoint list from device…');
  };

  const handleClearAll = () => {
    Alert.alert('Clear all waypoints?', 'This removes them from the app and the device.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: () => deleteAllWaypoints() },
    ]);
  };

  return (
    <ScrollView style={s.scroll} contentContainerStyle={s.container}>

      {/* BLE connection status */}
      <View style={s.card}>
        <Text style={s.cardTitle}>DEVICE</Text>
        <View style={[s.badge, { backgroundColor: bleBadge.bg }]}>
          <Text style={s.badgeText}>{bleBadge.text}</Text>
        </View>
        <Text style={s.info}>GPS module: u-blox NEO-M9N</Text>
        {gps && (
          <>
            <Text style={s.info}>Waypoints on device: {gps.wpCount}</Text>
            <Text style={s.info}>
              NTRIP: {gps.ntripState === 'streaming'
                ? `Streaming — ${(gps.ntripBytes / 1024).toFixed(1)} KB`
                : gps.ntripState === 'connecting' ? 'Connecting…' : 'Idle'}
            </Text>
          </>
        )}
        <View style={s.row}>
          <TouchableOpacity style={[s.btn, { backgroundColor: C.accent }]} onPress={handleSync}>
            <Text style={s.btnText}>Sync Waypoints</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.btn, { backgroundColor: C.red }]} onPress={handleClearAll}>
            <Text style={s.btnText}>Clear All</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* NTRIP config */}
      <View style={s.card}>
        <Text style={s.cardTitle}>NTRIP CONFIG</Text>
        <Text style={s.hint}>Config is sent over BLE to the device. Phone handles the TCP connection.</Text>
        <View style={s.presets}>
          {NTRIP_PRESETS.map(p => (
            <TouchableOpacity key={p.name} style={s.preset}
              onPress={() => { setHost(p.host); setPort(p.port); if (p.mnt) setMnt(p.mnt); }}>
              <Text style={s.presetText}>{p.name}</Text>
            </TouchableOpacity>
          ))}
        </View>
        {([
          { label: 'Host',        val: host, set: setHost },
          { label: 'Port',        val: port, set: setPort },
          { label: 'Mount point', val: mnt,  set: setMnt  },
          { label: 'Username',    val: usr,  set: setUsr  },
        ] as const).map(f => (
          <View key={f.label} style={s.field}>
            <Text style={s.fieldLabel}>{f.label}</Text>
            <TextInput style={s.input} value={f.val} onChangeText={f.set}
              autoCapitalize="none" autoCorrect={false} />
          </View>
        ))}
        <View style={s.field}>
          <Text style={s.fieldLabel}>Password</Text>
          <TextInput style={s.input} value={pwd} onChangeText={setPwd}
            secureTextEntry autoCapitalize="none" autoCorrect={false} />
        </View>
        <TouchableOpacity style={[s.btn, { backgroundColor: C.accent, marginTop: 8 }]}
          onPress={saveNtripToDevice}>
          <Text style={s.btnText}>Send NTRIP Config to Device</Text>
        </TouchableOpacity>
      </View>

      {/* Antenna height */}
      <View style={s.card}>
        <Text style={s.cardTitle}>ANTENNA HEIGHT</Text>
        <Text style={s.hint}>Pole height in metres. Subtracted from GPS altitude when saving waypoints.</Text>
        <View style={s.field}>
          <Text style={s.fieldLabel}>Height (m)</Text>
          <TextInput
            style={[s.input, { fontSize: 20, fontWeight: '700', textAlign: 'center' }]}
            value={antennaH}
            onChangeText={setAntennaH}
            keyboardType="decimal-pad"
            placeholder="0.000"
          />
        </View>
        <TouchableOpacity style={[s.btn, { backgroundColor: C.accent }]} onPress={saveAntennaHeight}>
          <Text style={s.btnText}>Set Antenna Height</Text>
        </TouchableOpacity>
      </View>

      {/* Accuracy filter */}
      <View style={s.card}>
        <Text style={s.cardTitle}>ACCURACY FILTER</Text>
        <View style={s.row}>
          <View style={s.fieldHalf}>
            <Text style={s.fieldLabel}>Min (m) — 0 = off</Text>
            <TextInput style={s.input} value={minAcc} onChangeText={setMinAccState} keyboardType="decimal-pad" />
          </View>
          <View style={s.fieldHalf}>
            <Text style={s.fieldLabel}>Max (m) — 0 = no limit</Text>
            <TextInput style={s.input} value={maxAcc} onChangeText={setMaxAccState} keyboardType="decimal-pad" />
          </View>
        </View>
        <TouchableOpacity style={[s.btn, { backgroundColor: C.accent }]} onPress={saveAcc}>
          <Text style={s.btnText}>Save Filter</Text>
        </TouchableOpacity>
      </View>

    </ScrollView>
  );
}

const s = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: C.bg },
  container: { padding: 16, paddingBottom: 40 },
  card: { backgroundColor: C.card, borderRadius: 12, padding: 14, marginBottom: 12 },
  cardTitle: { fontSize: 11, fontWeight: '700', color: C.accent, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 },
  badge: { borderRadius: 8, padding: 10, alignItems: 'center', marginBottom: 10 },
  badgeText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  hint: { fontSize: 12, color: C.muted, marginBottom: 10 },
  info: { fontSize: 13, color: C.muted, marginBottom: 4 },
  row: { flexDirection: 'row', gap: 8, marginTop: 8 },
  btn: { flex: 1, borderRadius: 10, padding: 12, alignItems: 'center' },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  presets: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
  preset: { backgroundColor: C.bg, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10, borderWidth: 1, borderColor: C.border },
  presetText: { fontSize: 11, color: C.accent, fontWeight: '600' },
  field: { marginBottom: 10 },
  fieldHalf: { flex: 1 },
  fieldLabel: { fontSize: 11, color: C.muted, marginBottom: 4 },
  input: { backgroundColor: C.bg, borderRadius: 8, padding: 10, fontSize: 14, color: C.text, borderWidth: 1, borderColor: C.border },
});
