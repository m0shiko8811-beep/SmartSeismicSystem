import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, FlatList, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import { useGps } from '../context/GpsContext';
import { exportAndShare, EPSG_LIST, EpsgOption } from '../services/export';
import { hdopToAccuracy, fixQualityName } from '../services/calculations';
import { Waypoint } from '../types/gps';
import { C } from '../theme';
import { loadLog, clearLog, logFilePath, LogEntry } from '../services/activityLog';

// ── Waypoints tab ─────────────────────────────────────
function WaypointItem({ wp }: { wp: Waypoint }) {
  const acc = hdopToAccuracy(wp.hdop, wp.fixQ);
  const color = acc < 2 ? C.green : acc < 5 ? C.amber : C.red;
  return (
    <View style={s.item}>
      <View style={s.itemLeft}>
        <Text style={s.itemLabel}>{wp.label}</Text>
        <Text style={s.itemCoords}>{wp.lat.toFixed(5)}, {wp.lon.toFixed(5)}</Text>
        <Text style={s.itemMeta}>{fixQualityName(wp.fixQ)} · {wp.ts.slice(11, 19)}</Text>
      </View>
      <View style={[s.accDot, { backgroundColor: color }]}>
        <Text style={s.accDotText}>{acc.toFixed(1)}m</Text>
      </View>
    </View>
  );
}

// ── Activity log tab ──────────────────────────────────
const EVENT_COLORS: Record<string, string> = {
  esp32_dbg:        '#4FC3F7',
  app_start:        '#81C784',
  ble_scan_start:   '#FFB74D',
  ble_device_found: '#FFB74D',
  ble_connected:    '#66BB6A',
  ble_disconnected: '#EF5350',
  ble_reconnect:    '#FF8A65',
  ble_rejected_device: '#EF5350',
  gps_fix_acquired: '#66BB6A',
  gps_fix_lost:     '#EF5350',
  gps_fixq_change:  '#4FC3F7',
  avg_started:      '#CE93D8',
  avg_done_rcvd:    '#CE93D8',
  avg_cancelled:    '#FF8A65',
  wp_saved:         '#81C784',
  wp_saved_at:      '#81C784',
  wp_cleared:       '#EF5350',
  wp_retake:        '#FF8A65',
  wp_list_synced:   '#4FC3F7',
  ntrip_start:      '#4FC3F7',
  ntrip_connected:  '#66BB6A',
  ntrip_error:      '#EF5350',
  ntrip_disconnected: '#FF8A65',
  ntrip_stopped:    '#FF8A65',
  ntrip_kb100:      '#4FC3F7',
};

function logColor(event: string): string {
  return EVENT_COLORS[event] ?? '#9E9E9E';
}

function LogEntryRow({ entry }: { entry: LogEntry }) {
  const color = logColor(entry.event);
  const time  = entry.ts.slice(11, 23); // HH:MM:SS.mmm
  const dataStr = entry.data ? ' ' + JSON.stringify(entry.data).replace(/"/g, '').slice(0, 80) : '';
  return (
    <View style={s.logRow}>
      <Text style={s.logTime}>{time}</Text>
      <View style={[s.logTag, { backgroundColor: color + '33', borderColor: color }]}>
        <Text style={[s.logEvent, { color }]}>{entry.event}</Text>
      </View>
      {!!dataStr && <Text style={s.logData} numberOfLines={2}>{dataStr}</Text>}
    </View>
  );
}

function ActivityLogTab() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    const data = await loadLog();
    setEntries(data);
  }, []);

  useEffect(() => {
    void refresh();
    if (autoRefresh) {
      intervalRef.current = setInterval(refresh, 2000);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [refresh, autoRefresh]);

  const handleClear = () => {
    Alert.alert('Clear activity log?', 'This deletes all logged events.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: async () => {
        await clearLog();
        setEntries([]);
      }},
    ]);
  };

  const handleExport = async () => {
    try {
      const path = logFilePath();
      const info = await FileSystem.getInfoAsync(path);
      if (!info.exists) { Alert.alert('No log', 'Activity log is empty.'); return; }
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const dateStr = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const exportPath = `${FileSystem.cacheDirectory}activity_log_${dateStr}.jsonl`;
      await FileSystem.copyAsync({ from: path, to: exportPath });
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) await Sharing.shareAsync(exportPath, { mimeType: 'text/plain', dialogTitle: 'Export Activity Log' });
    } catch (e: any) {
      Alert.alert('Export failed', e.message);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      {/* Toolbar */}
      <View style={s.logToolbar}>
        <TouchableOpacity onPress={() => setAutoRefresh(v => !v)}
          style={[s.logToolBtn, autoRefresh && s.logToolBtnActive]}>
          <Text style={[s.logToolBtnText, autoRefresh && s.logToolBtnActiveText]}>
            {autoRefresh ? '⏵ Auto' : '⏸ Paused'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={refresh} style={s.logToolBtn}>
          <Text style={s.logToolBtnText}>↻ Refresh</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={handleExport} style={s.logToolBtn}>
          <Text style={s.logToolBtnText}>↑ Export</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={handleClear} style={[s.logToolBtn, { borderColor: C.red }]}>
          <Text style={[s.logToolBtnText, { color: C.red }]}>✕ Clear</Text>
        </TouchableOpacity>
      </View>
      <Text style={s.logCount}>{entries.length} events (newest first)</Text>
      {entries.length === 0 ? (
        <View style={s.empty}>
          <Text style={s.emptyText}>No activity logged yet.{'\n'}Events appear here as the app and device operate.</Text>
        </View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(e, i) => `${e.ts}-${i}`}
          renderItem={({ item }) => <LogEntryRow entry={item} />}
          contentContainerStyle={{ paddingBottom: 16 }}
        />
      )}
    </View>
  );
}

// ── Main screen ───────────────────────────────────────
export default function LogScreen() {
  const { waypoints, deleteAllWaypoints, syncFromDevice } = useGps();
  const [exporting, setExporting] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [selectedEpsg, setSelectedEpsg] = useState<EpsgOption>(EPSG_LIST[0]);
  const [tab, setTab] = useState<'waypoints' | 'log'>('waypoints');

  const handleExport = async (fmt: 'csv' | 'kml') => {
    if (waypoints.length === 0) { Alert.alert('No waypoints', 'Save some waypoints first.'); return; }
    setExporting(true);
    try { await exportAndShare(waypoints, fmt); }
    catch (e: any) { Alert.alert('Export failed', e.message); }
    finally { setExporting(false); }
  };

  const handleExportWithProjection = async () => {
    if (waypoints.length === 0) { Alert.alert('No waypoints', 'Save some waypoints first.'); return; }
    setShowModal(false);
    setExporting(true);
    try { await exportAndShare(waypoints, 'csv', selectedEpsg); }
    catch (e: any) { Alert.alert('Export failed', e.message); }
    finally { setExporting(false); }
  };

  const handleClear = () => {
    Alert.alert('Clear all?', `Delete all ${waypoints.length} waypoints from phone and device?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteAllWaypoints() },
    ]);
  };

  return (
    <View style={s.container}>
      {/* Tab switcher */}
      <View style={s.tabs}>
        <TouchableOpacity style={[s.tab, tab === 'waypoints' && s.tabActive]} onPress={() => setTab('waypoints')}>
          <Text style={[s.tabText, tab === 'waypoints' && s.tabTextActive]}>
            Waypoints {waypoints.length > 0 ? `(${waypoints.length})` : ''}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.tab, tab === 'log' && s.tabActive]} onPress={() => setTab('log')}>
          <Text style={[s.tabText, tab === 'log' && s.tabTextActive]}>Activity Log</Text>
        </TouchableOpacity>
      </View>

      {tab === 'waypoints' ? (
        <View style={{ flex: 1 }}>
          {/* Header bar */}
          <View style={s.header}>
            <Text style={s.headerText}>{waypoints.length} waypoints</Text>
            <TouchableOpacity onPress={syncFromDevice} style={s.syncBtn}>
              <Text style={s.syncBtnText}>↻ Sync</Text>
            </TouchableOpacity>
          </View>
          {/* Export buttons */}
          <View style={s.exportRow}>
            <TouchableOpacity style={[s.exportBtn, { backgroundColor: C.accent }]}
              onPress={() => handleExport('csv')} disabled={exporting}>
              <Text style={s.exportBtnText}>{exporting ? '…' : 'CSV (UTM+ITM)'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.exportBtn, { backgroundColor: '#7B3F9E' }]}
              onPress={() => handleExport('kml')} disabled={exporting}>
              <Text style={s.exportBtnText}>{exporting ? '…' : 'Export KML'}</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity style={[s.epsgBtn, exporting && s.btnDisabled]}
            onPress={() => setShowModal(true)} disabled={exporting}>
            <Text style={s.epsgBtnText}>CSV with coordinate system…</Text>
          </TouchableOpacity>
          {waypoints.length === 0 ? (
            <View style={s.empty}>
              <Text style={s.emptyText}>No waypoints yet.{'\n'}Go to Survey tab to save points.</Text>
            </View>
          ) : (
            <FlatList
              data={[...waypoints].reverse()}
              keyExtractor={(wp) => String(wp.id)}
              renderItem={({ item }) => <WaypointItem wp={item} />}
              contentContainerStyle={{ paddingBottom: 80 }}
            />
          )}
          {waypoints.length > 0 && (
            <TouchableOpacity style={s.clearBtn} onPress={handleClear}>
              <Text style={s.clearBtnText}>Clear all</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <ActivityLogTab />
      )}

      {/* EPSG picker modal */}
      <Modal visible={showModal} transparent animationType="slide" onRequestClose={() => setShowModal(false)}>
        <View style={s.modalOverlay}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>Select Coordinate System</Text>
            <Text style={s.modalSub}>CSV will include lat/lon + projected X/Y</Text>
            <ScrollView style={s.epsgList}>
              {EPSG_LIST.map(epsg => (
                <TouchableOpacity key={epsg.code}
                  style={[s.epsgItem, selectedEpsg.code === epsg.code && s.epsgItemSelected]}
                  onPress={() => setSelectedEpsg(epsg)}>
                  <View style={[s.epsgRadio, selectedEpsg.code === epsg.code && s.epsgRadioSelected]} />
                  <View style={s.epsgItemText}>
                    <Text style={[s.epsgName, selectedEpsg.code === epsg.code && s.epsgNameSelected]}>
                      {epsg.label}
                    </Text>
                    <Text style={s.epsgCols}>Columns: {epsg.xHeader}, {epsg.yHeader}</Text>
                  </View>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <View style={s.modalBtns}>
              <TouchableOpacity style={s.modalCancel} onPress={() => setShowModal(false)}>
                <Text style={s.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.modalExport} onPress={handleExportWithProjection}>
                <Text style={s.modalExportText}>Export CSV</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container:  { flex: 1, backgroundColor: C.bg },
  // Tabs
  tabs:       { flexDirection: 'row', backgroundColor: C.card, borderBottomWidth: 1, borderBottomColor: C.border },
  tab:        { flex: 1, paddingVertical: 12, alignItems: 'center' },
  tabActive:  { borderBottomWidth: 2, borderBottomColor: C.accent },
  tabText:    { fontSize: 13, fontWeight: '600', color: C.muted },
  tabTextActive: { color: C.accent },
  // Waypoints
  header:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, paddingBottom: 8 },
  headerText: { fontSize: 16, fontWeight: '700', color: C.text },
  syncBtn:    { backgroundColor: C.card, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12 },
  syncBtnText:{ fontSize: 13, color: C.accent, fontWeight: '600' },
  exportRow:  { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  exportBtn:  { flex: 1, borderRadius: 10, padding: 12, alignItems: 'center' },
  exportBtnText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  epsgBtn:    { marginHorizontal: 16, marginBottom: 10, borderRadius: 10, padding: 12, alignItems: 'center', borderWidth: 1.5, borderColor: C.accent },
  epsgBtnText:{ color: C.accent, fontWeight: '700', fontSize: 13 },
  btnDisabled:{ opacity: 0.4 },
  empty:      { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyText:  { color: C.muted, fontSize: 15, textAlign: 'center', lineHeight: 24 },
  item:       { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, marginHorizontal: 16, marginBottom: 8, borderRadius: 10, padding: 12 },
  itemLeft:   { flex: 1 },
  itemLabel:  { fontSize: 16, fontWeight: '800', color: C.text },
  itemCoords: { fontSize: 12, color: C.muted, marginTop: 2 },
  itemMeta:   { fontSize: 11, color: C.muted, marginTop: 2 },
  accDot:     { borderRadius: 8, paddingVertical: 4, paddingHorizontal: 8, marginLeft: 8 },
  accDotText: { color: '#fff', fontWeight: '700', fontSize: 12 },
  clearBtn:   { margin: 16, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: C.red, alignItems: 'center' },
  clearBtnText: { color: C.red, fontWeight: '700', fontSize: 14 },
  // Activity log
  logToolbar: { flexDirection: 'row', gap: 6, padding: 10, flexWrap: 'wrap' },
  logToolBtn: { borderRadius: 8, paddingVertical: 5, paddingHorizontal: 10, borderWidth: 1, borderColor: C.border },
  logToolBtnActive: { backgroundColor: C.accent, borderColor: C.accent },
  logToolBtnText:   { fontSize: 12, color: C.muted, fontWeight: '600' },
  logToolBtnActiveText: { color: '#fff' },
  logCount:   { fontSize: 11, color: C.muted, paddingHorizontal: 12, paddingBottom: 4 },
  logRow:     { paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: C.border },
  logTime:    { fontSize: 10, color: C.muted, fontFamily: 'monospace', marginBottom: 2 },
  logTag:     { alignSelf: 'flex-start', borderRadius: 4, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 1, marginBottom: 2 },
  logEvent:   { fontSize: 11, fontWeight: '700', fontFamily: 'monospace' },
  logData:    { fontSize: 10, color: C.muted, fontFamily: 'monospace' },
  // Modal
  modalOverlay:  { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  modalCard:     { backgroundColor: C.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: '80%' },
  modalTitle:    { fontSize: 18, fontWeight: '800', color: C.text, marginBottom: 4 },
  modalSub:      { fontSize: 12, color: C.muted, marginBottom: 16 },
  epsgList:      { maxHeight: 320 },
  epsgItem:      { flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: 10, marginBottom: 6, backgroundColor: C.bg, gap: 12 },
  epsgItemSelected: { backgroundColor: '#1B2F1B', borderWidth: 1.5, borderColor: C.green },
  epsgRadio:     { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: C.muted },
  epsgRadioSelected: { borderColor: C.green, backgroundColor: C.green },
  epsgItemText:  { flex: 1 },
  epsgName:      { fontSize: 13, fontWeight: '700', color: C.text },
  epsgNameSelected: { color: C.green },
  epsgCols:      { fontSize: 11, color: C.muted, marginTop: 2 },
  modalBtns:     { flexDirection: 'row', gap: 10, marginTop: 16 },
  modalCancel:   { flex: 1, padding: 14, borderRadius: 10, alignItems: 'center', borderWidth: 1, borderColor: C.border },
  modalCancelText: { color: C.muted, fontWeight: '700', fontSize: 14 },
  modalExport:   { flex: 1, padding: 14, borderRadius: 10, alignItems: 'center', backgroundColor: C.green },
  modalExportText: { color: '#fff', fontWeight: '800', fontSize: 14 },
});
