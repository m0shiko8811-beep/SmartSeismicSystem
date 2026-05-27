import React, { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useGps } from '../context/GpsContext';
import { getAccSettings, setAccSettings, loadNtripConfigs, saveNtripConfigs, NtripSavedConfig } from '../services/storage';
import { C } from '../theme';

export default function SettingsScreen() {
  const { gps, bleStatus, sendCmd, sendNtripConfig, syncFromDevice, deleteAllWaypoints,
          accFilterEnabled, setAccFilterEnabled,
          ntripConnState, ntripKB, ntripError, startNtrip, stopNtrip } = useGps();

  const [host, setHost] = useState('');
  const [port, setPort] = useState('2101');
  const [mnt,  setMnt]  = useState('');
  const [usr,  setUsr]  = useState('');
  const [pwd,  setPwd]  = useState('');
  const [minAcc,      setMinAccState]   = useState('0');
  const [maxAcc,      setMaxAccState]   = useState('10');
  const [antennaH,    setAntennaH]      = useState('0.000');
  const [savedConfigs, setSavedConfigs] = useState<NtripSavedConfig[]>([]);
  const [savingName,   setSavingName]   = useState('');
  const [showSaveInput, setShowSaveInput] = useState(false);

  useEffect(() => {
    getAccSettings().then(({ minAcc, maxAcc }) => {
      setMinAccState(String(minAcc));
      setMaxAccState(String(maxAcc));
    });
    loadNtripConfigs().then(setSavedConfigs);
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

  const handleNtripConnect = () => {
    if (!host || !mnt) {
      Alert.alert('Missing fields', 'Fill in Host and Mount point.');
      return;
    }
    const portNum = parseInt(port, 10);
    if (!portNum || portNum < 1 || portNum > 65535) {
      Alert.alert('Invalid port', 'Port must be a number between 1 and 65535.');
      return;
    }
    const cfg = { host, port: String(portNum), mnt, usr, pwd };
    sendNtripConfig(cfg);
    startNtrip(cfg);
  };

  const handleSaveConfig = () => {
    if (!host) { Alert.alert('Missing', 'Enter a host first.'); return; }
    setSavingName(`${host}/${mnt || '*'}`);
    setShowSaveInput(true);
  };

  const confirmSaveConfig = () => {
    const name = savingName.trim();
    if (!name) return;
    const cfg: NtripSavedConfig = { name, host, port, mnt, usr, pwd };
    const updated = [...savedConfigs.filter(c => c.name !== name), cfg];
    setSavedConfigs(updated);
    saveNtripConfigs(updated);
    setShowSaveInput(false);
  };

  const handleLoadConfig = (cfg: NtripSavedConfig) => {
    setHost(cfg.host);
    setPort(cfg.port);
    setMnt(cfg.mnt);
    setUsr(cfg.usr);
    setPwd(cfg.pwd);
  };

  const handleDeleteConfig = (name: string) => {
    Alert.alert('Delete config?', `Remove "${name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: () => {
          const updated = savedConfigs.filter(c => c.name !== name);
          setSavedConfigs(updated);
          saveNtripConfigs(updated);
        },
      },
    ]);
  };

  const saveAntennaHeight = () => {
    const h = parseFloat(antennaH) || 0;
    if (h < 0 || h > 10) {
      Alert.alert('Invalid', 'Antenna height must be between 0 and 10 m.');
      return;
    }
    setAntennaH(h.toFixed(3));
    sendCmd({ cmd: 'cfg', ant_h: h });
    Alert.alert('Saved', `Antenna height set to ${h.toFixed(3)} m`);
  };

  const saveAcc = async () => {
    const mn = parseFloat(minAcc) || 0;
    const mx = parseFloat(maxAcc) || 10;
    await setAccSettings(mn, mx, accFilterEnabled);
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
        {gps && <Text style={s.info}>Waypoints on device: {gps.wpCount}</Text>}
        <Text style={s.info}>
          NTRIP: {ntripConnState === 'streaming'
            ? `● Streaming — ${ntripKB.toFixed(1)} KB received`
            : ntripConnState === 'connecting' ? '◌ Connecting…'
            : ntripConnState === 'error'      ? `✗ Failed: ${ntripError ?? 'unknown error'}`
            : '○ Not connected'}
        </Text>
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
        <Text style={s.hint}>Phone connects to caster via TCP and streams RTCM corrections to the device over BLE.</Text>

        {/* Saved configs */}
        {savedConfigs.length > 0 && (
          <View style={s.savedList}>
            {savedConfigs.map(cfg => (
              <View key={cfg.name} style={s.savedItem}>
                <TouchableOpacity style={s.savedLoad} onPress={() => handleLoadConfig(cfg)}>
                  <Text style={s.savedName} numberOfLines={1}>{cfg.name}</Text>
                  <Text style={s.savedSub} numberOfLines={1}>{cfg.host}:{cfg.port}/{cfg.mnt}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.savedDel} onPress={() => handleDeleteConfig(cfg.name)}>
                  <Text style={s.savedDelText}>✕</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        {showSaveInput && (
          <View style={s.saveBox}>
            <Text style={s.fieldLabel}>Config name</Text>
            <TextInput style={[s.input, { marginBottom: 8 }]} value={savingName}
              onChangeText={setSavingName} autoCapitalize="none" autoCorrect={false} autoFocus />
            <View style={s.row}>
              <TouchableOpacity style={[s.btn, { backgroundColor: C.accent }]} onPress={confirmSaveConfig}>
                <Text style={s.btnText}>Save</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.btn, { backgroundColor: C.border }]} onPress={() => setShowSaveInput(false)}>
                <Text style={[s.btnText, { color: C.text }]}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

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
        <View style={s.row}>
          <TouchableOpacity style={[s.btn, { backgroundColor: C.accent }]} onPress={handleSaveConfig}>
            <Text style={s.btnText}>Save Config</Text>
          </TouchableOpacity>
          {ntripConnState === 'idle' || ntripConnState === 'error' ? (
            <TouchableOpacity style={[s.btn, { backgroundColor: C.green }]} onPress={handleNtripConnect}>
              <Text style={s.btnText}>
                {ntripConnState === 'error' ? 'Retry Connect' : 'Apply & Connect'}
              </Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={[s.btn, { backgroundColor: C.red }]} onPress={stopNtrip}>
              <Text style={s.btnText}>
                {ntripConnState === 'connecting' ? 'Connecting… (tap to stop)' : 'Disconnect NTRIP'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
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

      {/* App version */}
      <Text style={s.version}>GPS Survey v2.7.0 (build 270)</Text>

      {/* Accuracy filter */}
      <View style={s.card}>
        <Text style={s.cardTitle}>ACCURACY FILTER</Text>
        <View style={[s.row, { alignItems: 'center', marginBottom: 10 }]}>
          <Text style={[s.fieldLabel, { flex: 1, marginBottom: 0 }]}>Enable accuracy filter</Text>
          <Switch
            value={accFilterEnabled}
            onValueChange={setAccFilterEnabled}
            thumbColor={accFilterEnabled ? C.accent : C.muted}
            trackColor={{ false: C.border, true: C.accent + '66' }}
          />
        </View>
        {accFilterEnabled && (
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
        )}
        <TouchableOpacity style={[s.btn, { backgroundColor: C.accent, marginTop: accFilterEnabled ? 0 : 4 }]} onPress={saveAcc}>
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
  saveBox: { backgroundColor: C.bg, borderRadius: 8, padding: 10, marginBottom: 12, borderWidth: 1, borderColor: C.accent },
  savedList: { marginBottom: 12, gap: 6 },
  savedItem: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.bg, borderRadius: 8, borderWidth: 1, borderColor: C.border, overflow: 'hidden' },
  savedLoad: { flex: 1, paddingVertical: 8, paddingHorizontal: 10 },
  savedName: { fontSize: 13, fontWeight: '700', color: C.text },
  savedSub:  { fontSize: 11, color: C.muted, marginTop: 1 },
  savedDel:  { paddingHorizontal: 14, paddingVertical: 8, backgroundColor: C.red },
  savedDelText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  field: { marginBottom: 10 },
  fieldHalf: { flex: 1 },
  fieldLabel: { fontSize: 11, color: C.muted, marginBottom: 4 },
  input:   { backgroundColor: C.bg, borderRadius: 8, padding: 10, fontSize: 14, color: C.text, borderWidth: 1, borderColor: C.border },
  version: { textAlign: 'center', fontSize: 11, color: C.muted, marginBottom: 12 },
});
