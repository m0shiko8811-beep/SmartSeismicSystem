import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, Image, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import { useGps } from '../context/GpsContext';
import { exportAndShare, exportAndShareWithPhotos, EPSG_LIST, EpsgOption } from '../services/export';
import { hdopToAccuracy, fixQualityName } from '../services/calculations';
import { qcCheck, QcIssue } from '../services/qc';
import { getAccSettings } from '../services/storage';
import { Waypoint } from '../types/gps';
import { C } from '../theme';
import { loadLog, clearLog, logFilePath, LogEntry } from '../services/activityLog';
import { nmeaLogPath, clearNmeaLog, getNmeaLogInfo } from '../services/nmeaLog';

// ── Waypoints tab ─────────────────────────────────────
function WaypointItem({ wp, flagged, onFlag, onDelete }: {
  wp: Waypoint;
  flagged: boolean;
  onFlag: () => void;
  onDelete: () => void;
}) {
  const acc = hdopToAccuracy(wp.hdop, wp.fixQ);
  const color = acc < 2 ? C.green : acc < 5 ? C.amber : C.red;
  return (
    <View style={[s.item, flagged && s.itemFlagged]}>
      <View style={s.itemLeft}>
        <View style={s.itemLabelRow}>
          <Text style={s.itemLabel}>{wp.label}{flagged ? ' ⚑' : ''}</Text>
          {wp.session ? <Text style={s.sessionBadge}>{wp.session}</Text> : null}
        </View>
        <Text style={s.itemCoords}>{wp.lat.toFixed(5)}, {wp.lon.toFixed(5)}</Text>
        <Text style={s.itemMeta}>{fixQualityName(wp.fixQ)} · {wp.ts.slice(11, 19)}</Text>
        {wp.notes ? <Text style={s.itemNotes}>📝 {wp.notes}</Text> : null}
      </View>
      {wp.photoUri ? (
        <Image source={{ uri: wp.photoUri }} style={s.itemThumb} />
      ) : (
        <View style={[s.accDot, { backgroundColor: color }]}>
          <Text style={s.accDotText}>{acc.toFixed(1)}m</Text>
        </View>
      )}
      <TouchableOpacity style={s.itemBtn} onPress={onFlag}>
        <Text style={[s.itemBtnText, { color: flagged ? '#FF6D00' : C.muted }]}>⚑</Text>
      </TouchableOpacity>
      <TouchableOpacity style={s.itemBtn} onPress={onDelete}>
        <Text style={[s.itemBtnText, { color: C.red }]}>✕</Text>
      </TouchableOpacity>
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
  const time  = entry.ts.slice(11, 23);
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

// ── QC modal ──────────────────────────────────────────
function QcModal({ issues, onExport, onCancel }: {
  issues: QcIssue[];
  onExport: () => void;
  onCancel: () => void;
}) {
  const typeLabel: Record<string, string> = {
    duplicate:     '⚠ Duplicate label',
    no_fix:        '✗ No GPS fix',
    poor_accuracy: '⚡ Poor accuracy',
    station_gap:   '↔ Station gap',
  };
  return (
    <View style={s.modalOverlay}>
      <View style={s.modalCard}>
        <Text style={s.modalTitle}>Export QC — {issues.length} issue{issues.length !== 1 ? 's' : ''}</Text>
        <Text style={s.modalSub}>Review before exporting</Text>
        <ScrollView style={{ maxHeight: 280 }}>
          {issues.map((issue, i) => (
            <View key={i} style={s.qcRow}>
              <Text style={s.qcType}>{typeLabel[issue.type] ?? issue.type}</Text>
              <Text style={s.qcLabel}>{issue.label}</Text>
              <Text style={s.qcDetail}>{issue.detail}</Text>
            </View>
          ))}
        </ScrollView>
        <View style={s.modalBtns}>
          <TouchableOpacity style={s.modalCancel} onPress={onCancel}>
            <Text style={s.modalCancelText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.modalExport} onPress={onExport}>
            <Text style={s.modalExportText}>Export Anyway</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

// ── Main screen ───────────────────────────────────────
export default function LogScreen() {
  const { waypoints, deleteAllWaypoints, syncFromDevice, flaggedLabels, toggleFlag, deleteWaypointByLabel } = useGps();
  const reversedWaypoints = useMemo(() => [...waypoints].reverse(), [waypoints]);
  const [exporting, setExporting] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [selectedEpsg, setSelectedEpsg] = useState<EpsgOption>(EPSG_LIST[0]);
  const [tab, setTab] = useState<'waypoints' | 'log'>('waypoints');
  const [nmeaInfo, setNmeaInfo] = useState<{ exists: boolean; size: number }>({ exists: false, size: 0 });
  const [qcIssues, setQcIssues] = useState<QcIssue[]>([]);
  const [pendingExportFn, setPendingExportFn] = useState<(() => void) | null>(null);
  const [maxAcc, setMaxAcc] = useState(10);

  useEffect(() => {
    getNmeaLogInfo().then(setNmeaInfo);
    const t = setInterval(() => getNmeaLogInfo().then(setNmeaInfo), 10000);
    getAccSettings().then(s => setMaxAcc(s.maxAcc));
    return () => clearInterval(t);
  }, []);

  const runWithQc = (exportFn: () => Promise<void>) => {
    if (waypoints.length === 0) { Alert.alert('No waypoints', 'Save some waypoints first.'); return; }
    const issues = qcCheck(waypoints, maxAcc);
    if (issues.length > 0) {
      setQcIssues(issues);
      setPendingExportFn(() => async () => {
        setQcIssues([]);
        setPendingExportFn(null);
        setExporting(true);
        try { await exportFn(); }
        catch (e: any) { Alert.alert('Export failed', e.message); }
        finally { setExporting(false); }
      });
    } else {
      setExporting(true);
      exportFn()
        .catch((e: any) => Alert.alert('Export failed', e.message))
        .finally(() => setExporting(false));
    }
  };

  const handleExport = (fmt: 'csv' | 'kml') =>
    runWithQc(() => exportAndShare(waypoints, fmt));

  const handleExportWithProjection = () => {
    setShowModal(false);
    runWithQc(() => exportAndShare(waypoints, 'csv', selectedEpsg));
  };

  const handleExportWithPhotos = () =>
    runWithQc(() => exportAndShareWithPhotos(waypoints));

  const handleClear = () => {
    Alert.alert('Clear all?', `Delete all ${waypoints.length} waypoints from phone and device?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteAllWaypoints() },
    ]);
  };

  const handleNmeaExport = async () => {
    try {
      const info = await getNmeaLogInfo();
      if (!info.exists) { Alert.alert('No NMEA log', 'Connect to GPS device to start logging NMEA.'); return; }
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const dateStr = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
      const exportPath = `${FileSystem.cacheDirectory}nmea_${dateStr}.nmea`;
      await FileSystem.copyAsync({ from: nmeaLogPath(), to: exportPath });
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) await Sharing.shareAsync(exportPath, { mimeType: 'text/plain', dialogTitle: 'Export NMEA Log' });
    } catch (e: any) { Alert.alert('Export failed', e.message); }
  };

  const handleNmeaClear = () => {
    Alert.alert('Clear NMEA log?', 'This deletes the raw NMEA sentence log.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: async () => { await clearNmeaLog(); setNmeaInfo({ exists: false, size: 0 }); }},
    ]);
  };

  const handleDeleteWp = (label: string) => {
    Alert.alert('Delete waypoint?', `Remove "${label}" from phone and device?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteWaypointByLabel(label) },
    ]);
  };

  const hasPhotos = waypoints.some(w => w.photoUri);

  return (
    <View style={s.container}>
      {/* QC modal */}
      {qcIssues.length > 0 && pendingExportFn && (
        <Modal visible transparent animationType="slide" onRequestClose={() => { setQcIssues([]); setPendingExportFn(null); }}>
          <QcModal
            issues={qcIssues}
            onExport={pendingExportFn}
            onCancel={() => { setQcIssues([]); setPendingExportFn(null); }}
          />
        </Modal>
      )}

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
          {hasPhotos && (
            <TouchableOpacity style={[s.photoExportBtn, exporting && s.btnDisabled]}
              onPress={handleExportWithPhotos} disabled={exporting}>
              <Text style={s.photoExportBtnText}>📷 Export CSV + Photos (ZIP)</Text>
            </TouchableOpacity>
          )}
          {/* NMEA log info row */}
          <View style={s.nmeaRow}>
            <Text style={s.nmeaText}>
              {nmeaInfo.exists
                ? `NMEA log: ${(nmeaInfo.size / 1024).toFixed(0)} KB`
                : 'NMEA log: not started'}
            </Text>
            <TouchableOpacity style={s.nmeaBtn} onPress={handleNmeaExport} disabled={!nmeaInfo.exists}>
              <Text style={[s.nmeaBtnText, !nmeaInfo.exists && { opacity: 0.4 }]}>↑ Export</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.nmeaBtn, { borderColor: C.red }]} onPress={handleNmeaClear} disabled={!nmeaInfo.exists}>
              <Text style={[s.nmeaBtnText, { color: C.red }, !nmeaInfo.exists && { opacity: 0.4 }]}>✕</Text>
            </TouchableOpacity>
          </View>
          {waypoints.length === 0 ? (
            <View style={s.empty}>
              <Text style={s.emptyText}>No waypoints yet.{'\n'}Go to Survey tab to save points.</Text>
            </View>
          ) : (
            <FlatList
              data={reversedWaypoints}
              keyExtractor={(wp) => String(wp.id)}
              renderItem={({ item }) => (
                <WaypointItem
                  wp={item}
                  flagged={flaggedLabels.has(item.label)}
                  onFlag={() => toggleFlag(item.label)}
                  onDelete={() => handleDeleteWp(item.label)}
                />
              )}
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
  tabs:       { flexDirection: 'row', backgroundColor: C.card, borderBottomWidth: 1, borderBottomColor: C.border },
  tab:        { flex: 1, paddingVertical: 12, alignItems: 'center' },
  tabActive:  { borderBottomWidth: 2, borderBottomColor: C.accent },
  tabText:    { fontSize: 13, fontWeight: '600', color: C.muted },
  tabTextActive: { color: C.accent },
  header:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, paddingBottom: 8 },
  headerText: { fontSize: 16, fontWeight: '700', color: C.text },
  syncBtn:    { backgroundColor: C.card, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12 },
  syncBtnText:{ fontSize: 13, color: C.accent, fontWeight: '600' },
  exportRow:  { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  exportBtn:  { flex: 1, borderRadius: 10, padding: 12, alignItems: 'center' },
  exportBtnText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  epsgBtn:    { marginHorizontal: 16, marginBottom: 6, borderRadius: 10, padding: 12, alignItems: 'center', borderWidth: 1.5, borderColor: C.accent },
  epsgBtnText:{ color: C.accent, fontWeight: '700', fontSize: 13 },
  photoExportBtn: { marginHorizontal: 16, marginBottom: 8, borderRadius: 10, padding: 12, alignItems: 'center', backgroundColor: '#1A3040', borderWidth: 1.5, borderColor: '#4FC3F7' },
  photoExportBtnText: { color: '#4FC3F7', fontWeight: '700', fontSize: 13 },
  btnDisabled:{ opacity: 0.4 },
  empty:      { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyText:  { color: C.muted, fontSize: 15, textAlign: 'center', lineHeight: 24 },
  item:       { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, marginHorizontal: 16, marginBottom: 8, borderRadius: 10, padding: 12 },
  itemLeft:   { flex: 1 },
  itemLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  itemLabel:  { fontSize: 16, fontWeight: '800', color: C.text },
  sessionBadge: { fontSize: 10, fontWeight: '700', color: C.amber, backgroundColor: C.amber + '22', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 },
  itemCoords: { fontSize: 12, color: C.muted, marginTop: 2 },
  itemMeta:   { fontSize: 11, color: C.muted, marginTop: 2 },
  itemNotes:  { fontSize: 11, color: C.accent, marginTop: 3 },
  itemThumb:  { width: 44, height: 44, borderRadius: 6, borderWidth: 1, borderColor: C.border, marginLeft: 8 },
  accDot:     { borderRadius: 8, paddingVertical: 4, paddingHorizontal: 8, marginLeft: 8 },
  accDotText: { color: '#fff', fontWeight: '700', fontSize: 12 },
  clearBtn:   { margin: 16, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: C.red, alignItems: 'center' },
  clearBtnText: { color: C.red, fontWeight: '700', fontSize: 14 },
  itemFlagged: { borderLeftWidth: 3, borderLeftColor: '#FF6D00' },
  itemBtn:    { padding: 8, marginLeft: 4 },
  itemBtnText:{ fontSize: 18, fontWeight: '700' },
  nmeaRow:    { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 8, gap: 8 },
  nmeaText:   { flex: 1, fontSize: 12, color: C.muted },
  nmeaBtn:    { borderRadius: 8, paddingVertical: 5, paddingHorizontal: 10, borderWidth: 1, borderColor: C.border },
  nmeaBtnText:{ fontSize: 12, color: C.accent, fontWeight: '600' },
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
  // QC
  qcRow:      { backgroundColor: C.bg, borderRadius: 8, padding: 10, marginBottom: 6 },
  qcType:     { fontSize: 11, fontWeight: '700', color: C.amber, marginBottom: 2 },
  qcLabel:    { fontSize: 13, fontWeight: '800', color: C.text },
  qcDetail:   { fontSize: 11, color: C.muted, marginTop: 2 },
  // Modals
  modalOverlay:  { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  modalCard:     { backgroundColor: C.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: '85%' },
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
