import React, { useState, useEffect } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useGps } from '../context/GpsContext';
import { hdopToAccuracy, isAccuracyInRange, haversineDist, bearing, formatDist, fixQualityName, fixQualityColor } from '../services/calculations';
import { getAccSettings } from '../services/storage';
import { C } from '../theme';

export default function SurveyScreen() {
  const { gps, saveWaypoint, startAvg, cancelAvg } = useGps();
  const [line, setLine] = useState('1001');
  const [station, setStation] = useState('1');
  const [step, setStep] = useState('1');
  const [countUp, setCountUp] = useState(true);
  const [minAcc, setMinAcc] = useState(0);
  const [maxAcc, setMaxAcc] = useState(10);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<string | null>(null);

  useEffect(() => {
    void activateKeepAwakeAsync();
    void getAccSettings().then(({ minAcc, maxAcc }) => { setMinAcc(minAcc); setMaxAcc(maxAcc); });
    return () => { void deactivateKeepAwake(); };
  }, []);

  // Sync cfg from device when GPS data arrives
  useEffect(() => {
    if (gps?.cfg) {
      setLine(String(gps.cfg.line));
      setStation(String(gps.cfg.sta));
      setStep(String(gps.cfg.step));
      setCountUp(gps.cfg.up);
    }
  }, [gps?.cfg?.line, gps?.cfg?.sta]);

  const label = `${line}:${station}`;
  const acc = gps ? hdopToAccuracy(gps.hdop) : 99;
  const inRange = gps?.fix ? isAccuracyInRange(acc, minAcc, maxAcc) : false;

  const distInfo = gps?.fix && gps.dist2last != null
    ? `${formatDist(gps.dist2last)} @ ${bearing(gps.lat, gps.lon, gps.lastWPLat, gps.lastWPLon).toFixed(0)}°`
    : null;

  const advanceStation = () => {
    const s = parseInt(station) || 1;
    const st = parseInt(step) || 1;
    setStation(String(countUp ? s + st : s - st));
  };

  const handleSave = async () => {
    if (!gps?.fix) { Alert.alert('No fix', 'Wait for GPS fix before saving.'); return; }
    if (!inRange) { Alert.alert('Out of range', `Accuracy ${acc.toFixed(1)}m is outside your filter (${minAcc}–${maxAcc}m).`); return; }
    setSaving(true);
    const ok = await saveWaypoint(label);
    setSaving(false);
    if (ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setLastSaved(label);
      advanceStation();
    }
  };

  const handleAvg = () => {
    if (!gps?.fix) { Alert.alert('No fix', 'Wait for GPS fix.'); return; }
    if (gps.averaging) { cancelAvg(); return; }
    startAvg(label);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };

  // When averaging completes, advance station
  useEffect(() => {
    if (gps?.avgDone && gps.lastAvg) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setLastSaved(gps.lastAvg.label);
      setLine(String(gps.lastAvg.next_line));
      setStation(String(gps.lastAvg.next_sta));
    }
  }, [gps?.avgDone]);

  return (
    <ScrollView style={s.scroll} contentContainerStyle={s.container}>
      {/* Label preview */}
      <View style={s.labelBox}>
        <Text style={s.labelSmall}>Next waypoint</Text>
        <Text style={s.labelBig}>{label}</Text>
        {lastSaved && <Text style={s.savedText}>✓ Saved {lastSaved}</Text>}
      </View>

      {/* Accuracy status */}
      <View style={[s.accBadge, { backgroundColor: inRange ? C.green : C.red }]}>
        <Text style={s.badgeText}>
          {gps?.fix ? `${acc.toFixed(1)} m — ${inRange ? '✓ In range' : '✗ Out of range'}` : 'No GPS fix'}
          {gps?.fix ? `  •  ${fixQualityName(gps.fixQ)}  •  ${gps.sats} sats` : ''}
        </Text>
      </View>

      {distInfo && (
        <Text style={s.distText}>↗ {distInfo} to last point</Text>
      )}

      {gps?.cfg?.ant_h != null && gps.cfg.ant_h > 0 && (
        <Text style={s.distText}>Antenna height: {gps.cfg.ant_h.toFixed(3)} m</Text>
      )}

      {/* Config */}
      <View style={s.card}>
        <Text style={s.cardTitle}>NUMBERING</Text>
        <View style={s.cfgRow}>
          <View style={s.cfgField}>
            <Text style={s.cfgLabel}>Line</Text>
            <TextInput style={s.input} value={line} onChangeText={setLine} keyboardType="numeric" />
          </View>
          <View style={s.cfgField}>
            <Text style={s.cfgLabel}>Station</Text>
            <TextInput style={s.input} value={station} onChangeText={setStation} keyboardType="numeric" />
          </View>
          <View style={s.cfgField}>
            <Text style={s.cfgLabel}>Step</Text>
            <TextInput style={s.input} value={step} onChangeText={setStep} keyboardType="numeric" />
          </View>
        </View>
        <TouchableOpacity style={s.dirBtn} onPress={() => setCountUp(v => !v)}>
          <Text style={s.dirBtnText}>{countUp ? '▲ COUNT UP' : '▼ COUNT DOWN'}</Text>
        </TouchableOpacity>
      </View>

      {/* Averaging progress */}
      {gps?.averaging && (
        <View style={s.avgBox}>
          <Text style={s.avgText}>Averaging… {gps.avgCount}/{gps.avgTotal}</Text>
          <View style={s.barBg}>
            <View style={[s.barFill, { width: `${(gps.avgCount / gps.avgTotal) * 100}%` as any }]} />
          </View>
        </View>
      )}

      {/* Action buttons */}
      <TouchableOpacity
        style={[s.btnSave, (!gps?.fix || saving) && s.btnDisabled]}
        onPress={handleSave}
        disabled={!gps?.fix || saving}
      >
        <Text style={s.btnText}>{saving ? 'Saving…' : 'SAVE WAYPOINT'}</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[s.btnAvg, gps?.averaging && s.btnCancel]}
        onPress={handleAvg}
        disabled={!gps?.fix && !gps?.averaging}
      >
        <Text style={s.btnText}>{gps?.averaging ? 'CANCEL AVERAGE' : 'AVG 5 POINTS (~40s)'}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: C.bg },
  container: { padding: 16, paddingBottom: 40 },
  labelBox: { backgroundColor: C.card, borderRadius: 16, padding: 20, alignItems: 'center', marginBottom: 12 },
  labelSmall: { fontSize: 12, color: C.muted, textTransform: 'uppercase', letterSpacing: 1 },
  labelBig: { fontSize: 42, fontWeight: '900', color: C.accent, marginVertical: 4 },
  savedText: { fontSize: 13, color: C.green, fontWeight: '600' },
  accBadge: { borderRadius: 10, padding: 12, marginBottom: 8, alignItems: 'center' },
  badgeText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  distText: { textAlign: 'center', color: C.muted, fontSize: 13, marginBottom: 12 },
  card: { backgroundColor: C.card, borderRadius: 12, padding: 14, marginBottom: 12 },
  cardTitle: { fontSize: 11, fontWeight: '700', color: C.accent, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 },
  cfgRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  cfgField: { flex: 1 },
  cfgLabel: { fontSize: 11, color: C.muted, marginBottom: 4 },
  input: { backgroundColor: C.bg, borderRadius: 8, padding: 10, fontSize: 16, fontWeight: '700', color: C.text, textAlign: 'center', borderWidth: 1, borderColor: C.border },
  dirBtn: { backgroundColor: C.bg, borderRadius: 8, padding: 10, alignItems: 'center', borderWidth: 1, borderColor: C.border },
  dirBtnText: { fontSize: 13, fontWeight: '700', color: C.accent },
  avgBox: { backgroundColor: C.card, borderRadius: 12, padding: 14, marginBottom: 12 },
  avgText: { fontSize: 14, color: C.text, fontWeight: '600', marginBottom: 8 },
  barBg: { height: 8, backgroundColor: C.border, borderRadius: 4, overflow: 'hidden' },
  barFill: { height: 8, backgroundColor: C.accent, borderRadius: 4 },
  btnSave: { backgroundColor: C.green, borderRadius: 14, padding: 18, alignItems: 'center', marginBottom: 10 },
  btnAvg: { backgroundColor: C.accent, borderRadius: 14, padding: 18, alignItems: 'center' },
  btnCancel: { backgroundColor: C.red },
  btnDisabled: { opacity: 0.4 },
  btnText: { color: '#fff', fontWeight: '900', fontSize: 16, letterSpacing: 0.5 },
});
