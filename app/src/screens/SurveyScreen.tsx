import React, { useState, useEffect, useRef } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useGps } from '../context/GpsContext';
import { hdopToAccuracy, isAccuracyInRange, haversineDist, bearing, formatDist, fixQualityInfo, correctionSource } from '../services/calculations';
import { getAccSettings } from '../services/storage';
import { C } from '../theme';

const STATION_STORAGE_KEY = 'survey_station';

export default function SurveyScreen() {
  const { gps, waypoints, saveWaypoint, startAvg, cancelAvg, deleteLastWaypoints,
          accFilterEnabled, mapTargetPos, setMapTargetPos,
          avgResult, clearAvgResult, ntripConnState, ntripKB } = useGps();

  const [line,       setLine]       = useState('1001');
  const [station,    setStation]    = useState('1');
  const [step,       setStep]       = useState('1');
  const [countUp,    setCountUp]    = useState(true);
  const [minAcc,     setMinAcc]     = useState(0);
  const [maxAcc,     setMaxAcc]     = useState(10);
  const [saving,     setSaving]     = useState(false);
  const savingRef = useRef(false);
  const [lastSaved,  setLastSaved]  = useState<string | null>(null);
  const [retakeCount, setRetakeCount] = useState('1');

  useEffect(() => {
    void activateKeepAwakeAsync();
    void getAccSettings().then(({ minAcc, maxAcc }) => { setMinAcc(minAcc); setMaxAcc(maxAcc); });
    void AsyncStorage.getItem(STATION_STORAGE_KEY).then(v => { if (v) setStation(v); });
    return () => { void deactivateKeepAwake(); };
  }, []);

  const label   = `${line}:${station}`;
  const acc     = gps ? hdopToAccuracy(gps.hdop, gps.fixQ) : 99;
  const inRange = gps?.fix
    ? (accFilterEnabled ? isAccuracyInRange(acc, minAcc, maxAcc) : true)
    : false;
  const fixInfo  = gps ? fixQualityInfo(gps.fixQ) : null;
  const distInfo = gps?.fix && gps.dist2last != null
    ? `${formatDist(gps.dist2last)} @ ${bearing(gps.lat, gps.lon, gps.lastWPLat, gps.lastWPLon).toFixed(0)}°`
    : null;

  const advanceStation = () => {
    const s   = parseInt(station) || 1;
    const st  = parseInt(step)    || 1;
    const next = String(countUp ? s + st : s - st);
    setStation(next);
    void AsyncStorage.setItem(STATION_STORAGE_KEY, next);
  };

  const doSave = async (tapLat?: number, tapLon?: number) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const ok = tapLat !== undefined && tapLon !== undefined
      ? await saveWaypoint(label, tapLat, tapLon)
      : await saveWaypoint(label);
    setSaving(false);
    savingRef.current = false;
    if (ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setLastSaved(label);
      advanceStation();
    }
  };

  const handleSave = async () => {
    if (mapTargetPos) {
      // Save at map-tapped position — no fix required
      const exists = waypoints.some(w => w.label === label);
      if (exists) {
        Alert.alert(
          'Waypoint already exists',
          `"${label}" was already saved. Overwrite with map position?`,
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Overwrite', style: 'destructive', onPress: () => doSave(mapTargetPos.lat, mapTargetPos.lon) },
          ]
        );
        return;
      }
      await doSave(mapTargetPos.lat, mapTargetPos.lon);
      return;
    }
    if (!gps?.fix) { Alert.alert('No fix', 'Wait for GPS fix before saving.'); return; }
    if (!inRange)  { Alert.alert('Out of range', `Accuracy ${acc.toFixed(1)} m is outside your filter (${minAcc}–${maxAcc} m).`); return; }
    const exists = waypoints.some(w => w.label === label);
    if (exists) {
      Alert.alert(
        'Waypoint already exists',
        `"${label}" was already saved. Overwrite it with the current position?`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Overwrite', style: 'destructive', onPress: () => doSave() },
        ]
      );
      return;
    }
    await doSave();
  };

  const handleAvg = () => {
    if (!gps?.fix) { Alert.alert('No fix', 'Wait for GPS fix.'); return; }
    if (gps.averaging) { cancelAvg(); return; }
    startAvg(label);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };

  const handleRetake = () => {
    const n = parseInt(retakeCount) || 1;
    if (n < 1) return;
    Alert.alert(
      'Retake last points?',
      `Delete the last ${n} waypoint(s) from both device and phone, and reverse the station counter?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Retake', style: 'destructive', onPress: () => {
          deleteLastWaypoints(n);
          const s    = parseInt(station) || 1;
          const st   = parseInt(step)    || 1;
          const prev = String(countUp ? s - (n * st) : s + (n * st));
          setStation(prev);
          void AsyncStorage.setItem(STATION_STORAGE_KEY, prev);
          setLastSaved(null);
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        }},
      ]
    );
  };

  // avgResult is a dedicated state set once by avg_done notification, never reset by GPS JSON
  useEffect(() => {
    if (avgResult) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setLastSaved(avgResult.label);
      advanceStation();
      clearAvgResult();
    }
  }, [avgResult]); // eslint-disable-line react-hooks/exhaustive-deps

  const ntripBg = ntripConnState === 'streaming' ? '#1B5E20'
                : ntripConnState === 'connecting' ? '#E65100'
                : '#374151';
  const ntripText = ntripConnState === 'streaming'
    ? `● NTRIP ACTIVE — ${ntripKB.toFixed(1)} KB received`
    : ntripConnState === 'connecting' ? '◌ NTRIP connecting…' : '○ NTRIP — not connected';

  return (
    <ScrollView style={s.scroll} contentContainerStyle={s.container}>
      {/* Label preview */}
      <View style={s.labelBox}>
        <Text style={s.labelSmall}>Next waypoint</Text>
        <Text style={s.labelBig}>{label}</Text>
        {lastSaved && <Text style={s.savedText}>✓ Saved {lastSaved}</Text>}
      </View>

      {/* Map-tap position banner */}
      {mapTargetPos && (
        <View style={s.tapBanner}>
          <View style={s.tapBannerMain}>
            <Text style={s.tapBannerTitle}>📍 Saving at map position</Text>
            <Text style={s.tapBannerCoords}>
              {mapTargetPos.lat.toFixed(7)}, {mapTargetPos.lon.toFixed(7)}
            </Text>
          </View>
          <TouchableOpacity style={s.tapClearBtn} onPress={() => setMapTargetPos(null)}>
            <Text style={s.tapClearText}>Clear</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Accuracy status */}
      <View style={[s.accBadge, { backgroundColor: inRange ? C.green : C.red }]}>
        <Text style={s.badgeText}>
          {gps?.fix
            ? `${acc.toFixed(1)} m (est.) — ${inRange ? '✓ In range' : accFilterEnabled ? '✗ Out of range' : '⊘ Filter off'}  •  ${gps.sats} sats`
            : 'No GPS fix'}
        </Text>
      </View>

      {/* NTRIP status — always visible */}
      <View style={[s.ntripRow, { backgroundColor: ntripBg }]}>
        <Text style={s.ntripText}>{ntripText}</Text>
      </View>

      {fixInfo && gps?.fix && (
        <View style={[s.fixRow, { borderLeftColor: fixInfo.color }]}>
          <View style={[s.fixDot, { backgroundColor: fixInfo.color }]} />
          <View>
            <Text style={s.fixName}>{fixInfo.name}</Text>
            <Text style={s.fixDesc}>{fixInfo.desc}  ·  {fixInfo.accuracy}</Text>
            <Text style={s.fixSrc}>{correctionSource(gps.fixQ, ntripConnState)}</Text>
          </View>
        </View>
      )}

      {distInfo && <Text style={s.distText}>↗ {distInfo} to last point</Text>}

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

      {/* Retake */}
      <View style={s.retakeRow}>
        <Text style={s.retakeLabel}>Retake last</Text>
        <TextInput
          style={s.retakeInput}
          value={retakeCount}
          onChangeText={setRetakeCount}
          keyboardType="numeric"
        />
        <Text style={s.retakeLabel}>point(s)</Text>
        <TouchableOpacity style={s.retakeBtn} onPress={handleRetake}>
          <Text style={s.retakeBtnText}>RETAKE</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  scroll:      { flex: 1, backgroundColor: C.bg },
  container:   { padding: 16, paddingBottom: 40 },
  labelBox:    { backgroundColor: C.card, borderRadius: 16, padding: 20, alignItems: 'center', marginBottom: 12 },
  labelSmall:  { fontSize: 12, color: C.muted, textTransform: 'uppercase', letterSpacing: 1 },
  labelBig:    { fontSize: 42, fontWeight: '900', color: C.accent, marginVertical: 4 },
  savedText:   { fontSize: 13, color: C.green, fontWeight: '600' },
  accBadge:    { borderRadius: 10, padding: 12, marginBottom: 8, alignItems: 'center' },
  badgeText:   { color: '#fff', fontWeight: '700', fontSize: 13 },
  ntripRow:    { borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12, marginBottom: 8, alignItems: 'center' },
  ntripText:   { fontSize: 12, fontWeight: '700', color: '#fff' },
  fixRow:      { flexDirection: 'row', alignItems: 'flex-start', borderLeftWidth: 4, borderRadius: 8, backgroundColor: C.card, padding: 10, marginBottom: 8, gap: 10 },
  fixDot:      { width: 10, height: 10, borderRadius: 5, marginTop: 3 },
  fixName:     { fontSize: 13, fontWeight: '700', color: C.text },
  fixDesc:     { fontSize: 11, color: C.muted, marginTop: 1 },
  fixSrc:      { fontSize: 11, color: C.accent, fontWeight: '600', marginTop: 2 },
  distText:    { textAlign: 'center', color: C.muted, fontSize: 13, marginBottom: 12 },
  card:        { backgroundColor: C.card, borderRadius: 12, padding: 14, marginBottom: 12 },
  cardTitle:   { fontSize: 11, fontWeight: '700', color: C.accent, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 },
  cfgRow:      { flexDirection: 'row', gap: 8, marginBottom: 10 },
  cfgField:    { flex: 1 },
  cfgLabel:    { fontSize: 11, color: C.muted, marginBottom: 4 },
  input:       { backgroundColor: C.bg, borderRadius: 8, padding: 10, fontSize: 16, fontWeight: '700', color: C.text, textAlign: 'center', borderWidth: 1, borderColor: C.border },
  dirBtn:      { backgroundColor: C.bg, borderRadius: 8, padding: 10, alignItems: 'center', borderWidth: 1, borderColor: C.border },
  dirBtnText:  { fontSize: 13, fontWeight: '700', color: C.accent },
  avgBox:      { backgroundColor: C.card, borderRadius: 12, padding: 14, marginBottom: 12 },
  avgText:     { fontSize: 14, color: C.text, fontWeight: '600', marginBottom: 8 },
  barBg:       { height: 8, backgroundColor: C.border, borderRadius: 4, overflow: 'hidden' },
  barFill:     { height: 8, backgroundColor: C.accent, borderRadius: 4 },
  btnSave:     { backgroundColor: C.green, borderRadius: 14, padding: 18, alignItems: 'center', marginBottom: 10 },
  btnAvg:      { backgroundColor: C.accent, borderRadius: 14, padding: 18, alignItems: 'center', marginBottom: 10 },
  btnCancel:   { backgroundColor: C.red },
  btnDisabled: { opacity: 0.4 },
  btnText:     { color: '#fff', fontWeight: '900', fontSize: 16, letterSpacing: 0.5 },
  retakeRow:   { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.card, borderRadius: 12, padding: 12 },
  retakeLabel: { fontSize: 13, color: C.muted, fontWeight: '600' },
  retakeInput: { backgroundColor: C.bg, borderRadius: 8, padding: 8, fontSize: 15, fontWeight: '700', color: C.text, textAlign: 'center', borderWidth: 1, borderColor: C.border, width: 50 },
  retakeBtn:   { flex: 1, backgroundColor: C.red, borderRadius: 10, padding: 10, alignItems: 'center' },
  retakeBtnText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  tapBanner:   { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1A2A1A', borderRadius: 10, borderWidth: 1.5, borderColor: '#FF6D00', padding: 10, marginBottom: 8, gap: 8 },
  tapBannerMain: { flex: 1 },
  tapBannerTitle: { fontSize: 13, fontWeight: '800', color: '#FF6D00' },
  tapBannerCoords: { fontSize: 11, color: '#FFCC80', marginTop: 2 },
  tapClearBtn: { backgroundColor: '#FF6D00', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  tapClearText: { color: '#fff', fontWeight: '800', fontSize: 12 },
});
