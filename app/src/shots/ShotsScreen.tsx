import React, { useCallback, useState } from 'react';
import {
  Alert, FlatList, Modal, ScrollView, StyleSheet,
  Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { useGps } from '../context/GpsContext';
import { ShotRecord, ShotConfig } from './types';
import { EPSG_LIST, EpsgOption, exportShots } from '../services/export';
import { C } from '../theme';

const DEBOUNCE_OPTIONS = [100, 200, 500, 1000, 2000];

function fixBadge(fixQ: number): { text: string; color: string } {
  if (fixQ === 4) return { text: 'RTK', color: C.green };
  if (fixQ === 5) return { text: 'FLT', color: C.amber };
  if (fixQ === 2) return { text: 'DIF', color: C.accent };
  if (fixQ === 1) return { text: 'GPS', color: C.muted };
  return { text: '---', color: C.red };
}

function ShotRow({ shot, onDelete, onBad }: {
  shot: ShotRecord;
  onDelete: () => void;
  onBad: () => void;
}) {
  const badge = fixBadge(shot.fixQ);
  const timePart = shot.ts.length >= 19 ? shot.ts.substring(11, 23) : shot.ts;
  return (
    <View style={[s.row, shot.bad && s.rowBad]}>
      <View style={s.rowLeft}>
        <Text style={[s.rowId, shot.bad && s.rowIdBad]}>#{shot.id}</Text>
        <View>
          <Text style={[s.rowLabel, shot.bad && s.rowLabelBad]}>
            L{shot.line} : SP{shot.sp}
          </Text>
          <Text style={s.rowTime}>{timePart}</Text>
        </View>
      </View>
      <View style={s.rowRight}>
        <Text style={[s.badge, { backgroundColor: badge.color }]}>{badge.text}</Text>
        <TouchableOpacity style={s.actionBtn} onPress={onBad}>
          <Text style={s.actionBtnTxt}>{shot.bad ? 'OK' : 'Bad'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.actionBtn, s.actionBtnRed]} onPress={onDelete}>
          <Text style={[s.actionBtnTxt, { color: '#fff' }]}>Del</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default function ShotsScreen() {
  const {
    shots, shotCfg, setShotCfg,
    clearShots, deleteShot, markShotBad,
    shotPlan, loadShotPlanFromCSV, clearShotPlan,
  } = useGps();

  const [localCfg, setLocalCfg] = useState<ShotConfig>(shotCfg);
  React.useEffect(() => { setLocalCfg(shotCfg); }, [shotCfg.line, shotCfg.sp]);

  const [epsgModal, setEpsgModal] = useState(false);
  const [exporting, setExporting] = useState(false);

  const handleApply = useCallback(() => {
    setShotCfg(localCfg);
  }, [localCfg, setShotCfg]);

  const handleImportPlan = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['text/csv', 'text/comma-separated-values', 'text/plain', '*/*'],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.length) return;
      const uri = result.assets[0].uri;
      const csv = await FileSystem.readAsStringAsync(uri);
      loadShotPlanFromCSV(csv);
      Alert.alert('Plan loaded', `${csv.trim().split('\n').length} points imported.`);
    } catch {
      Alert.alert('Error', 'Could not read CSV file.');
    }
  };

  const handleExport = async (epsg: EpsgOption) => {
    setEpsgModal(false);
    setExporting(true);
    try {
      await exportShots(shots, epsg);
    } catch (e: any) {
      Alert.alert('Export failed', e?.message ?? String(e));
    } finally {
      setExporting(false);
    }
  };

  const handleClearAll = () => {
    Alert.alert('Clear all shots?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: clearShots },
    ]);
  };

  const goodCount = shots.filter(s => !s.bad).length;
  const badCount  = shots.filter(s => s.bad).length;

  return (
    <View style={s.container}>
      <View style={s.card}>
        <Text style={s.cardTitle}>Shot Trigger Config</Text>
        <View style={s.row2}>
          <View style={s.field}>
            <Text style={s.label}>Line</Text>
            <TextInput
              style={s.input}
              keyboardType="numeric"
              value={String(localCfg.line)}
              onChangeText={v => setLocalCfg(c => ({ ...c, line: parseInt(v) || c.line }))}
            />
          </View>
          <View style={s.field}>
            <Text style={s.label}>SP</Text>
            <TextInput
              style={s.input}
              keyboardType="numeric"
              value={String(localCfg.sp)}
              onChangeText={v => setLocalCfg(c => ({ ...c, sp: parseInt(v) || c.sp }))}
            />
          </View>
          <View style={s.field}>
            <Text style={s.label}>Step</Text>
            <View style={s.stepRow}>
              <TouchableOpacity
                style={[s.stepBtn, localCfg.step < 0 && s.stepBtnActive]}
                onPress={() => setLocalCfg(c => ({ ...c, step: -Math.abs(c.step) }))}
              >
                <Text style={s.stepBtnTxt}>▼</Text>
              </TouchableOpacity>
              <TextInput
                style={[s.input, { width: 48 }]}
                keyboardType="numeric"
                value={String(Math.abs(localCfg.step))}
                onChangeText={v => {
                  const n = parseInt(v) || 1;
                  setLocalCfg(c => ({ ...c, step: c.step < 0 ? -n : n }));
                }}
              />
              <TouchableOpacity
                style={[s.stepBtn, localCfg.step > 0 && s.stepBtnActive]}
                onPress={() => setLocalCfg(c => ({ ...c, step: Math.abs(c.step) }))}
              >
                <Text style={s.stepBtnTxt}>▲</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
        <View style={s.row2}>
          <View style={s.field}>
            <Text style={s.label}>Trigger edge</Text>
            <View style={s.segRow}>
              <TouchableOpacity
                style={[s.seg, localCfg.edge === 'falling' && s.segActive]}
                onPress={() => setLocalCfg(c => ({ ...c, edge: 'falling' }))}
              >
                <Text style={[s.segTxt, localCfg.edge === 'falling' && s.segTxtActive]}>▼ Falling</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.seg, localCfg.edge === 'rising' && s.segActive]}
                onPress={() => setLocalCfg(c => ({ ...c, edge: 'rising' }))}
              >
                <Text style={[s.segTxt, localCfg.edge === 'rising' && s.segTxtActive]}>▲ Rising</Text>
              </TouchableOpacity>
            </View>
          </View>
          <View style={s.field}>
            <Text style={s.label}>Debounce</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={s.segRow}>
                {DEBOUNCE_OPTIONS.map(ms => (
                  <TouchableOpacity
                    key={ms}
                    style={[s.seg, localCfg.debounce === ms && s.segActive]}
                    onPress={() => setLocalCfg(c => ({ ...c, debounce: ms }))}
                  >
                    <Text style={[s.segTxt, localCfg.debounce === ms && s.segTxtActive]}>
                      {ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
          </View>
        </View>
        <TouchableOpacity style={s.applyBtn} onPress={handleApply}>
          <Text style={s.applyBtnTxt}>Apply to device</Text>
        </TouchableOpacity>
      </View>

      <View style={s.statsBar}>
        <Text style={s.statsTxt}>
          {shots.length} shots · {goodCount} good · {badCount > 0 ? `${badCount} bad` : ''}
          {shotPlan.length > 0 ? `  ·  Plan: ${shotPlan.length} pts` : ''}
        </Text>
      </View>

      {shots.length === 0 ? (
        <View style={s.empty}>
          <Text style={s.emptyTxt}>No shots recorded yet.</Text>
          <Text style={s.emptySubTxt}>Connect the hammer to GPIO 32 and hit the plate.</Text>
        </View>
      ) : (
        <FlatList
          data={[...shots].reverse()}
          keyExtractor={s => String(s.id)}
          renderItem={({ item }) => (
            <ShotRow
              shot={item}
              onDelete={() => {
                Alert.alert('Delete shot?', `Shot #${item.id} L${item.line}:SP${item.sp}`, [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Delete', style: 'destructive', onPress: () => deleteShot(item.id) },
                ]);
              }}
              onBad={() => markShotBad(item.id, !item.bad)}
            />
          )}
          contentContainerStyle={{ paddingBottom: 8 }}
        />
      )}

      <View style={s.actions}>
        <TouchableOpacity style={s.actionCard} onPress={handleImportPlan}>
          <Text style={s.actionIcon}>📂</Text>
          <Text style={s.actionLbl}>Import Plan</Text>
        </TouchableOpacity>
        {shotPlan.length > 0 && (
          <TouchableOpacity style={s.actionCard} onPress={() => {
            Alert.alert('Clear shot plan?', undefined, [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Clear', style: 'destructive', onPress: clearShotPlan },
            ]);
          }}>
            <Text style={s.actionIcon}>🗑</Text>
            <Text style={s.actionLbl}>Clear Plan</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[s.actionCard, shots.length === 0 && s.actionCardDisabled]}
          disabled={shots.length === 0 || exporting}
          onPress={() => setEpsgModal(true)}
        >
          <Text style={s.actionIcon}>📤</Text>
          <Text style={s.actionLbl}>{exporting ? 'Exporting…' : 'Export CSV'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.actionCard, shots.length === 0 && s.actionCardDisabled]}
          disabled={shots.length === 0}
          onPress={handleClearAll}
        >
          <Text style={s.actionIcon}>🗑</Text>
          <Text style={s.actionLbl}>Clear All</Text>
        </TouchableOpacity>
      </View>

      <Modal visible={epsgModal} transparent animationType="fade" onRequestClose={() => setEpsgModal(false)}>
        <TouchableOpacity style={s.modalBackdrop} activeOpacity={1} onPress={() => setEpsgModal(false)}>
          <View style={s.modalBox} onStartShouldSetResponder={() => true}>
            <Text style={s.modalTitle}>Select coordinate system</Text>
            {EPSG_LIST.map(epsg => (
              <TouchableOpacity key={epsg.code} style={s.epsgRow} onPress={() => handleExport(epsg)}>
                <Text style={s.epsgLabel}>{epsg.label}</Text>
                <Text style={s.epsgCols}>{epsg.xHeader} / {epsg.yHeader}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={s.cancelBtn} onPress={() => setEpsgModal(false)}>
              <Text style={s.cancelTxt}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container:  { flex: 1, backgroundColor: C.bg },
  card:       { backgroundColor: C.card, margin: 8, borderRadius: 10, padding: 12, elevation: 2 },
  cardTitle:  { fontSize: 13, fontWeight: '700', color: C.accent, marginBottom: 8 },
  row2:       { flexDirection: 'row', gap: 10, marginBottom: 8 },
  field:      { flex: 1 },
  label:      { fontSize: 11, color: C.muted, marginBottom: 3 },
  input:      { borderWidth: 1, borderColor: C.border, borderRadius: 6, padding: 6,
                fontSize: 14, color: C.text, backgroundColor: C.bg, textAlign: 'center' },
  stepRow:    { flexDirection: 'row', alignItems: 'center', gap: 4 },
  stepBtn:    { padding: 6, borderRadius: 6, borderWidth: 1, borderColor: C.border, backgroundColor: C.bg },
  stepBtnActive: { backgroundColor: C.accent, borderColor: C.accent },
  stepBtnTxt: { fontSize: 13, color: C.text },
  segRow:     { flexDirection: 'row', gap: 4 },
  seg:        { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6,
                borderWidth: 1, borderColor: C.border, backgroundColor: C.bg },
  segActive:  { backgroundColor: C.accent, borderColor: C.accent },
  segTxt:     { fontSize: 12, color: C.text },
  segTxtActive: { color: '#fff', fontWeight: '700' },
  applyBtn:   { backgroundColor: C.accent, borderRadius: 8, paddingVertical: 9, alignItems: 'center', marginTop: 4 },
  applyBtnTxt:{ color: '#fff', fontWeight: '700', fontSize: 14 },
  statsBar:   { paddingHorizontal: 12, paddingVertical: 5, backgroundColor: C.card, borderBottomWidth: 1, borderBottomColor: C.border },
  statsTxt:   { fontSize: 12, color: C.muted },
  empty:      { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 },
  emptyTxt:   { fontSize: 16, color: C.muted, textAlign: 'center', fontWeight: '600' },
  emptySubTxt:{ fontSize: 12, color: C.muted, textAlign: 'center', marginTop: 8 },
  row:        { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
                backgroundColor: C.card, marginHorizontal: 8, marginTop: 4,
                borderRadius: 8, padding: 10, elevation: 1 },
  rowBad:     { backgroundColor: '#FFF5F5', borderWidth: 1, borderColor: '#FFCDD2' },
  rowLeft:    { flexDirection: 'row', alignItems: 'center', gap: 10 },
  rowRight:   { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowId:      { fontSize: 13, fontWeight: '800', color: C.accent, minWidth: 28 },
  rowIdBad:   { color: C.red },
  rowLabel:   { fontSize: 14, fontWeight: '700', color: C.text },
  rowLabelBad:{ color: C.red, textDecorationLine: 'line-through' },
  rowTime:    { fontSize: 11, color: C.muted, fontFamily: 'monospace' },
  badge:      { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 4,
                fontSize: 11, fontWeight: '800', color: '#fff', overflow: 'hidden' },
  actionBtn:  { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 5,
                borderWidth: 1, borderColor: C.border, backgroundColor: C.bg },
  actionBtnRed: { backgroundColor: C.red, borderColor: C.red },
  actionBtnTxt: { fontSize: 11, color: C.text },
  actions:    { flexDirection: 'row', padding: 8, gap: 8, backgroundColor: C.card,
                borderTopWidth: 1, borderTopColor: C.border },
  actionCard: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 8,
                borderWidth: 1, borderColor: C.border, backgroundColor: C.bg },
  actionCardDisabled: { opacity: 0.4 },
  actionIcon: { fontSize: 20 },
  actionLbl:  { fontSize: 10, color: C.muted, marginTop: 2 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 24 },
  modalBox:   { backgroundColor: C.card, borderRadius: 14, padding: 16, elevation: 8 },
  modalTitle: { fontSize: 15, fontWeight: '700', color: C.text, marginBottom: 12 },
  epsgRow:    { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border },
  epsgLabel:  { fontSize: 14, color: C.text, fontWeight: '600' },
  epsgCols:   { fontSize: 11, color: C.muted, marginTop: 1 },
  cancelBtn:  { marginTop: 12, paddingVertical: 10, alignItems: 'center' },
  cancelTxt:  { fontSize: 14, color: C.muted },
});
