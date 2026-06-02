import React, { useState, useEffect, useRef } from 'react';
import { Alert, Image, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { playWpSound } from '../services/sounds';
import * as ImagePicker from 'expo-image-picker';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useGps } from '../context/GpsContext';
import { hdopToAccuracy, isAccuracyInRange, haversineDist, bearing, formatDist, fixQualityInfo, fixQualityName, correctionSource } from '../services/calculations';
import { getAccSettings } from '../services/storage';
import { speakWaypoint, speakText } from '../services/tts';
import { C } from '../theme';

const STATION_STORAGE_KEY = 'survey_station';

const BEARING_ARROWS = ['↑','↗','→','↘','↓','↙','←','↖'];
function bearingArrow(deg: number): string {
  const idx = Math.round(((deg % 360) + 360) % 360 / 45) % 8;
  return BEARING_ARROWS[idx];
}

function cardinalDir(deg: number): string {
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

function fmtDuration(startedAt: number): string {
  const sec = Math.floor((Date.now() - startedAt) / 1000);
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function SurveyScreen() {
  const { gps, waypoints, saveWaypoint, startAvg, cancelAvg, deleteLastWaypoints,
          accFilterEnabled, mapTargetPos, setMapTargetPos,
          avgResult, clearAvgResult, ntripConnState, ntripKB, ntripRetryIn,
          voiceEnabled,
          sessionName, setSessionName,
          stakeoutTargets, stakeoutIdx, setStakeoutIdx,
          loadStakeoutFromCSV, clearStakeout,
          ntripStreamingStartedAt } = useGps();

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
  const [stakeoutOpen, setStakeoutOpen] = useState(false);
  const [autoAdvance, setAutoAdvance] = useState(false);
  const [autoAdvanceDist, setAutoAdvanceDist] = useState('3');
  const autoAdvancedRef = useRef(false);
  const [showCsvModal, setShowCsvModal] = useState(false);
  const [csvText, setCsvText] = useState('');
  // Notes + photo
  const [noteText, setNoteText]           = useState('');
  const [pendingPhotoUri, setPendingPhotoUri] = useState<string | null>(null);
  // RTK timer tick
  const [, setTick] = useState(0);

  useEffect(() => {
    void activateKeepAwakeAsync();
    void getAccSettings().then(({ minAcc, maxAcc }) => { setMinAcc(minAcc); setMaxAcc(maxAcc); });
    void AsyncStorage.getItem(STATION_STORAGE_KEY).then(v => { if (v) setStation(v); });
    return () => { void deactivateKeepAwake(); };
  }, []);

  // RTK streaming timer — tick every second while streaming
  useEffect(() => {
    if (!ntripStreamingStartedAt) return;
    const t = setInterval(() => setTick(v => v + 1), 1000);
    return () => clearInterval(t);
  }, [ntripStreamingStartedAt]);

  const label   = `${line}:${station}`;
  const acc     = gps ? hdopToAccuracy(gps.hdop, gps.fixQ) : 99;
  const inRange = gps?.fix
    ? (accFilterEnabled ? isAccuracyInRange(acc, minAcc, maxAcc) : true)
    : false;
  const fixInfo  = gps ? fixQualityInfo(gps.fixQ) : null;
  const distInfo = gps?.fix && gps.dist2last != null
    ? `${formatDist(gps.dist2last)} @ ${bearing(gps.lat, gps.lon, gps.lastWPLat, gps.lastWPLon).toFixed(0)}°`
    : null;

  // ── Stakeout: sync line/station when target has LINE:STATION label ───
  useEffect(() => {
    if (!stakeoutTargets.length) return;
    const target = stakeoutTargets[stakeoutIdx];
    if (!target) return;
    const sep = target.label.indexOf(':');
    if (sep <= 0) return;
    const newLine = target.label.substring(0, sep).trim();
    const newSta  = target.label.substring(sep + 1).trim();
    if (newLine && /^\d+$/.test(newLine)) setLine(newLine);
    if (newSta  && /^-?\d+$/.test(newSta))  {
      setStation(newSta);
      void AsyncStorage.setItem(STATION_STORAGE_KEY, newSta);
    }
  }, [stakeoutIdx, stakeoutTargets]);

  // ── Stakeout: distance + bearing to current target ───
  const stakeoutTarget = stakeoutTargets[stakeoutIdx] ?? null;
  const stakeoutDist = gps?.fix && stakeoutTarget
    ? haversineDist(gps.lat, gps.lon, stakeoutTarget.lat, stakeoutTarget.lon)
    : null;
  const stakeoutBearing = gps?.fix && stakeoutTarget
    ? bearing(gps.lat, gps.lon, stakeoutTarget.lat, stakeoutTarget.lon)
    : null;

  // ── Stakeout: auto-advance when within threshold ──────
  useEffect(() => {
    if (!autoAdvance || !stakeoutTarget || stakeoutDist === null) return;
    const threshold = parseFloat(autoAdvanceDist) || 3;
    if (stakeoutDist <= threshold && !autoAdvancedRef.current) {
      autoAdvancedRef.current = true;
      const next = stakeoutIdx + 1;
      if (next < stakeoutTargets.length) {
        setStakeoutIdx(next);
        speakText(`Arrived. Next: ${stakeoutTargets[next].label.replace(/:/g, ' ')}`);
        // Only reset flag after walking well clear — prevents double-advance from GPS noise
        setTimeout(() => { autoAdvancedRef.current = false; }, 5000);
      } else {
        speakText('All stakeout points reached');
        setTimeout(() => { autoAdvancedRef.current = false; }, 5000);
      }
    }
    // Don't reset flag on distance increase — the timeout handles reset safely
  }, [stakeoutDist]); // eslint-disable-line react-hooks/exhaustive-deps

  const advanceStation = () => {
    const s   = parseInt(station) || 1;
    const st  = parseInt(step)    || 1;
    const next = String(countUp ? s + st : s - st);
    setStation(next);
    void AsyncStorage.setItem(STATION_STORAGE_KEY, next);
  };

  const reverseStation = () => {
    const s  = parseInt(station) || 1;
    const st = parseInt(step)    || 1;
    const prev = String(countUp ? s - st : s + st);
    setStation(prev);
    void AsyncStorage.setItem(STATION_STORAGE_KEY, prev);
  };

  const doSave = async (tapLat?: number, tapLon?: number) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const fromMap = tapLat !== undefined && tapLon !== undefined;
    const ok = fromMap
      ? await saveWaypoint(label, tapLat, tapLon, noteText || undefined, pendingPhotoUri || undefined)
      : await saveWaypoint(label, undefined, undefined, noteText || undefined, pendingPhotoUri || undefined);
    setSaving(false);
    savingRef.current = false;
    if (ok) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      playWpSound();
      setLastSaved(label);
      setNoteText('');
      setPendingPhotoUri(null);
      advanceStation();
      if (voiceEnabled) {
        speakWaypoint(label, gps ? fixQualityName(gps.fixQ) : 'saved', fromMap);
      }
    }
  };

  const handleSave = async () => {
    if (mapTargetPos) {
      const exists = waypoints.some(w => w.label === label);
      if (exists) {
        Alert.alert('Waypoint already exists', `"${label}" already saved. Overwrite with map position?`, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Overwrite', style: 'destructive', onPress: () => doSave(mapTargetPos.lat, mapTargetPos.lon) },
        ]);
        return;
      }
      await doSave(mapTargetPos.lat, mapTargetPos.lon);
      return;
    }
    if (!gps?.fix) { Alert.alert('No fix', 'Wait for GPS fix before saving.'); return; }
    if (!inRange)  { Alert.alert('Out of range', `Accuracy ${acc.toFixed(1)} m is outside your filter (${minAcc}–${maxAcc} m).`); return; }
    const exists = waypoints.some(w => w.label === label);
    if (exists) {
      Alert.alert('Waypoint already exists', `"${label}" already saved. Overwrite?`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Overwrite', style: 'destructive', onPress: () => doSave() },
      ]);
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
    Alert.alert('Retake last points?',
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

  const handleQuickUndo = () => {
    if (waypoints.length === 0) return;
    const last = waypoints[waypoints.length - 1];
    deleteLastWaypoints(1);
    reverseStation();
    setLastSaved(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    // brief toast via setLastSaved
    setLastSaved(`↩ Undid ${last.label}`);
    setTimeout(() => setLastSaved(null), 2000);
  };

  const handleTakePhoto = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') { Alert.alert('Permission required', 'Camera access is needed to attach photos.'); return; }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.7, allowsEditing: false });
    if (!result.canceled && result.assets[0]) {
      setPendingPhotoUri(result.assets[0].uri);
    }
  };

  const handleImportStakeout = () => {
    setCsvText('');
    setShowCsvModal(true);
  };

  const confirmCsvImport = () => {
    if (!csvText.trim()) { Alert.alert('Empty', 'Paste CSV content first.'); return; }
    loadStakeoutFromCSV(csvText);
    setShowCsvModal(false);
    // Brief delay so state updates before we read stakeoutTargets length
    setTimeout(() => {
      if (stakeoutTargets.length === 0) {
        Alert.alert('No valid points', 'CSV parsed but found no valid rows.\nExpected format: Label,Lat,Lon');
      } else {
        setStakeoutOpen(true);
      }
    }, 100);
  };

  useEffect(() => {
    if (avgResult) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setLastSaved(avgResult.label);
      advanceStation();
      if (voiceEnabled) speakWaypoint(avgResult.label, 'averaged', false);
      clearAvgResult();
    }
  }, [avgResult]); // eslint-disable-line react-hooks/exhaustive-deps

  const ntripBg = ntripConnState === 'streaming' ? '#1B5E20'
                : ntripConnState === 'connecting' ? '#E65100'
                : '#374151';
  const ntripText = ntripConnState === 'streaming'
    ? `● NTRIP ACTIVE — ${ntripKB.toFixed(1)} KB${ntripStreamingStartedAt ? `  ·  ${fmtDuration(ntripStreamingStartedAt)} streaming` : ''}`
    : ntripConnState === 'connecting'
      ? ntripRetryIn != null ? `↻ NTRIP reconnecting in ${ntripRetryIn}s…` : '◌ NTRIP connecting…'
    : '○ NTRIP — not connected';

  return (
    <View style={{ flex: 1 }}>
      <ScrollView style={s.scroll} contentContainerStyle={s.container}>
        {/* Label preview */}
        <View style={s.labelBox}>
          <Text style={s.labelSmall}>Next waypoint</Text>
          <Text style={s.labelBig}>{label}</Text>
          {sessionName ? <Text style={s.sessionTag}>{sessionName}</Text> : null}
          {lastSaved && <Text style={s.savedText}>{lastSaved.startsWith('↩') ? lastSaved : `✓ Saved ${lastSaved}`}</Text>}
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

        {/* NTRIP status */}
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

        {/* Job / Session */}
        <View style={s.card}>
          <Text style={s.cardTitle}>JOB / SESSION</Text>
          <TextInput
            style={s.jobInput}
            value={sessionName}
            onChangeText={setSessionName}
            placeholder="e.g. Line A, Survey 2026-05-28…"
            placeholderTextColor={C.muted}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        {/* Numbering */}
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

        {/* Stakeout */}
        <View style={s.card}>
          <TouchableOpacity style={s.stakeoutHeader} onPress={() => setStakeoutOpen(v => !v)}>
            <Text style={s.cardTitle}>STAKEOUT{stakeoutTargets.length > 0 ? ` (${stakeoutTargets.length} pts)` : ''}</Text>
            <Text style={s.stakeoutChevron}>{stakeoutOpen ? '▲' : '▼'}</Text>
          </TouchableOpacity>

          {stakeoutOpen && (
            <>
              <View style={s.stakeoutBtnRow}>
                <TouchableOpacity style={[s.stakeoutBtn, { backgroundColor: C.accent }]} onPress={handleImportStakeout}>
                  <Text style={s.stakeoutBtnText}>↑ Import CSV</Text>
                </TouchableOpacity>
                {stakeoutTargets.length > 0 && (
                  <TouchableOpacity style={[s.stakeoutBtn, { backgroundColor: C.red }]} onPress={() => {
                    Alert.alert('Clear stakeout?', 'Remove all planned points?', [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Clear', style: 'destructive', onPress: clearStakeout },
                    ]);
                  }}>
                    <Text style={s.stakeoutBtnText}>✕ Clear</Text>
                  </TouchableOpacity>
                )}
              </View>

              {stakeoutTargets.length > 0 ? (
                <>
                  <View style={s.stakeoutTarget}>
                    <Text style={s.stakeoutCounter}>
                      {stakeoutIdx + 1} / {stakeoutTargets.length}
                    </Text>
                    <Text style={s.stakeoutName} numberOfLines={1}>
                      {stakeoutTarget?.label ?? '—'}
                    </Text>
                    {stakeoutTarget?.notes ? (
                      <Text style={s.stakeoutNotes}>{stakeoutTarget.notes}</Text>
                    ) : null}
                    {stakeoutDist !== null && stakeoutBearing !== null ? (
                      <View style={s.stakeoutNav}>
                        <Text style={s.stakeoutArrow}>{bearingArrow(stakeoutBearing)}</Text>
                        <View>
                          <Text style={s.stakeoutDist}>{formatDist(stakeoutDist)}</Text>
                          <Text style={s.stakeoutDir}>{stakeoutBearing.toFixed(0)}°  {cardinalDir(stakeoutBearing)}</Text>
                        </View>
                      </View>
                    ) : (
                      <Text style={s.stakeoutNoFix}>Waiting for GPS fix…</Text>
                    )}
                  </View>

                  <View style={s.stakeoutNavRow}>
                    <TouchableOpacity
                      style={[s.navBtn, stakeoutIdx === 0 && s.navBtnDisabled]}
                      disabled={stakeoutIdx === 0}
                      onPress={() => { autoAdvancedRef.current = false; setStakeoutIdx(Math.max(0, stakeoutIdx - 1)); }}>
                      <Text style={s.navBtnText}>◀ Prev</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[s.navBtn, stakeoutIdx >= stakeoutTargets.length - 1 && s.navBtnDisabled]}
                      disabled={stakeoutIdx >= stakeoutTargets.length - 1}
                      onPress={() => { autoAdvancedRef.current = false; setStakeoutIdx(Math.min(stakeoutTargets.length - 1, stakeoutIdx + 1)); }}>
                      <Text style={s.navBtnText}>Next ▶</Text>
                    </TouchableOpacity>
                  </View>

                  <View style={s.autoRow}>
                    <TouchableOpacity
                      style={[s.autoToggle, autoAdvance && s.autoToggleOn]}
                      onPress={() => setAutoAdvance(v => !v)}>
                      <Text style={[s.autoToggleText, autoAdvance && s.autoToggleTextOn]}>
                        {autoAdvance ? '● Auto-advance ON' : '○ Auto-advance OFF'}
                      </Text>
                    </TouchableOpacity>
                    <TextInput
                      style={s.autoDistInput}
                      value={autoAdvanceDist}
                      onChangeText={setAutoAdvanceDist}
                      keyboardType="decimal-pad"
                    />
                    <Text style={s.autoDistLabel}>m</Text>
                  </View>
                </>
              ) : (
                <Text style={s.stakeoutHint}>
                  CSV format: Label,Lat,Lon{'\n'}
                  e.g.  ST001,31.7683,35.2137
                </Text>
              )}
            </>
          )}
        </View>

        {/* Notes + Photo row */}
        <View style={s.card}>
          <Text style={s.cardTitle}>FIELD NOTE  /  PHOTO</Text>
          <TextInput
            style={s.noteInput}
            value={noteText}
            onChangeText={setNoteText}
            placeholder="Optional note for next waypoint…"
            placeholderTextColor={C.muted}
            autoCapitalize="sentences"
            autoCorrect
            multiline
            numberOfLines={2}
          />
          <View style={s.photoRow}>
            <TouchableOpacity style={s.photoBtn} onPress={handleTakePhoto}>
              <Text style={s.photoBtnText}>{pendingPhotoUri ? '📷 Retake' : '📷 Take photo'}</Text>
            </TouchableOpacity>
            {pendingPhotoUri && (
              <>
                <Image source={{ uri: pendingPhotoUri }} style={s.photoThumb} />
                <TouchableOpacity style={s.photoClear} onPress={() => setPendingPhotoUri(null)}>
                  <Text style={s.photoClearText}>✕</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
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
          style={[s.btnSave, ((!gps?.fix && !mapTargetPos) || saving) && s.btnDisabled]}
          onPress={handleSave}
          disabled={(!gps?.fix && !mapTargetPos) || saving}
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

        {/* CSV paste modal */}
        <Modal visible={showCsvModal} transparent animationType="slide" onRequestClose={() => setShowCsvModal(false)}>
          <View style={s.modalOverlay}>
            <View style={s.modalCard}>
              <Text style={s.modalTitle}>Paste Stakeout CSV</Text>
              <Text style={s.modalHint}>Format: Label,Lat,Lon  (one point per line)</Text>
              <TextInput
                style={s.csvInput}
                value={csvText}
                onChangeText={setCsvText}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={'ST001,31.7683,35.2137\nST002,31.7695,35.2150'}
                placeholderTextColor={C.muted}
              />
              <View style={s.modalBtns}>
                <TouchableOpacity style={s.modalCancel} onPress={() => setShowCsvModal(false)}>
                  <Text style={s.modalCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.modalImport} onPress={confirmCsvImport}>
                  <Text style={s.modalImportText}>Import</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

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

      {/* Quick undo FAB */}
      {waypoints.length > 0 && (
        <TouchableOpacity style={s.undoFab} onPress={handleQuickUndo}>
          <Text style={s.undoFabText}>↩</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  scroll:      { flex: 1, backgroundColor: C.bg },
  container:   { padding: 16, paddingBottom: 80 },
  labelBox:    { backgroundColor: C.card, borderRadius: 16, padding: 20, alignItems: 'center', marginBottom: 12 },
  labelSmall:  { fontSize: 12, color: C.muted, textTransform: 'uppercase', letterSpacing: 1 },
  labelBig:    { fontSize: 42, fontWeight: '900', color: C.accent, marginVertical: 4 },
  savedText:   { fontSize: 13, color: C.green, fontWeight: '600' },
  sessionTag:  { fontSize: 12, color: C.amber, fontWeight: '700', paddingHorizontal: 10, paddingVertical: 2, borderRadius: 8, backgroundColor: C.amber + '22', marginTop: 2 },
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
  cardTitle:   { fontSize: 11, fontWeight: '700', color: C.accent, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 },
  jobInput:    { backgroundColor: C.bg, borderRadius: 8, padding: 10, fontSize: 14, color: C.text, borderWidth: 1, borderColor: C.border },
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
  // Notes + photo
  noteInput:   { backgroundColor: C.bg, borderRadius: 8, padding: 10, fontSize: 13, color: C.text, borderWidth: 1, borderColor: C.border, marginBottom: 10, textAlignVertical: 'top', minHeight: 50 },
  photoRow:    { flexDirection: 'row', alignItems: 'center', gap: 10 },
  photoBtn:    { backgroundColor: C.bg, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: C.border },
  photoBtnText:{ fontSize: 13, color: C.accent, fontWeight: '700' },
  photoThumb:  { width: 48, height: 48, borderRadius: 6, borderWidth: 1, borderColor: C.border },
  photoClear:  { backgroundColor: C.red, borderRadius: 14, width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  photoClearText: { color: '#fff', fontWeight: '900', fontSize: 12 },
  // Quick undo FAB
  undoFab:     { position: 'absolute', bottom: 24, right: 16, backgroundColor: C.amber, width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', elevation: 6 },
  undoFabText: { color: '#fff', fontSize: 22, fontWeight: '900' },
  // Stakeout
  stakeoutHeader:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  stakeoutChevron: { fontSize: 12, color: C.muted },
  stakeoutBtnRow:  { flexDirection: 'row', gap: 8, marginBottom: 12 },
  stakeoutBtn:     { flex: 1, borderRadius: 8, padding: 10, alignItems: 'center' },
  stakeoutBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  stakeoutTarget:  { backgroundColor: C.bg, borderRadius: 10, padding: 12, marginBottom: 10 },
  stakeoutCounter: { fontSize: 11, color: C.muted, marginBottom: 2 },
  stakeoutName:    { fontSize: 20, fontWeight: '900', color: C.text, marginBottom: 4 },
  stakeoutNotes:   { fontSize: 12, color: C.muted, marginBottom: 6 },
  stakeoutNav:     { flexDirection: 'row', alignItems: 'center', gap: 16 },
  stakeoutArrow:   { fontSize: 52, color: C.accent },
  stakeoutDist:    { fontSize: 28, fontWeight: '900', color: C.accent },
  stakeoutDir:     { fontSize: 14, color: C.muted, marginTop: 2 },
  stakeoutNoFix:   { fontSize: 13, color: C.muted, fontStyle: 'italic', marginTop: 4 },
  stakeoutNavRow:  { flexDirection: 'row', gap: 8, marginBottom: 8 },
  navBtn:          { flex: 1, backgroundColor: C.accent, borderRadius: 8, padding: 10, alignItems: 'center' },
  navBtnDisabled:  { backgroundColor: C.border },
  navBtnText:      { color: '#fff', fontWeight: '700', fontSize: 13 },
  autoRow:         { flexDirection: 'row', alignItems: 'center', gap: 8 },
  autoToggle:      { flex: 1, borderRadius: 8, padding: 8, borderWidth: 1, borderColor: C.border, alignItems: 'center' },
  autoToggleOn:    { backgroundColor: C.green, borderColor: C.green },
  autoToggleText:  { fontSize: 12, fontWeight: '700', color: C.muted },
  autoToggleTextOn:{ color: '#fff' },
  autoDistInput:   { backgroundColor: C.bg, borderRadius: 8, padding: 8, fontSize: 14, fontWeight: '700', color: C.text, textAlign: 'center', borderWidth: 1, borderColor: C.border, width: 48 },
  autoDistLabel:   { fontSize: 13, color: C.muted, fontWeight: '600' },
  stakeoutHint:    { fontSize: 12, color: C.muted, fontFamily: 'monospace', lineHeight: 18 },
  // CSV modal
  modalOverlay:    { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  modalCard:       { backgroundColor: C.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20 },
  modalTitle:      { fontSize: 17, fontWeight: '800', color: C.text, marginBottom: 4 },
  modalHint:       { fontSize: 12, color: C.muted, marginBottom: 10, fontFamily: 'monospace' },
  csvInput:        { backgroundColor: C.bg, borderRadius: 10, padding: 12, fontSize: 13, color: C.text, borderWidth: 1, borderColor: C.border, height: 160, textAlignVertical: 'top', fontFamily: 'monospace', marginBottom: 12 },
  modalBtns:       { flexDirection: 'row', gap: 10 },
  modalCancel:     { flex: 1, padding: 14, borderRadius: 10, alignItems: 'center', borderWidth: 1, borderColor: C.border },
  modalCancelText: { color: C.muted, fontWeight: '700', fontSize: 14 },
  modalImport:     { flex: 1, padding: 14, borderRadius: 10, alignItems: 'center', backgroundColor: C.accent },
  modalImportText: { color: '#fff', fontWeight: '800', fontSize: 14 },
});
