import React, { useState } from 'react';
import { Alert, FlatList, Share, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useGps } from '../context/GpsContext';
import { exportAndShare } from '../services/export';
import { hdopToAccuracy, fixQualityName } from '../services/calculations';
import { Waypoint } from '../types/gps';
import { C } from '../theme';

function WaypointItem({ wp }: { wp: Waypoint }) {
  const acc = hdopToAccuracy(wp.hdop);
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

export default function LogScreen() {
  const { waypoints, deleteAllWaypoints, syncFromDevice } = useGps();
  const [exporting, setExporting] = useState(false);

  const handleExport = async (fmt: 'csv' | 'kml') => {
    if (waypoints.length === 0) { Alert.alert('No waypoints', 'Save some waypoints first.'); return; }
    setExporting(true);
    try {
      await exportAndShare(waypoints, fmt);
    } catch (e: any) {
      Alert.alert('Export failed', e.message);
    } finally {
      setExporting(false);
    }
  };

  const handleClear = () => {
    Alert.alert('Clear all?', `Delete all ${waypoints.length} waypoints from phone and device?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteAllWaypoints() },
    ]);
  };

  return (
    <View style={s.container}>
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
          <Text style={s.exportBtnText}>{exporting ? '…' : 'Export CSV'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.exportBtn, { backgroundColor: '#7B3F9E' }]}
          onPress={() => handleExport('kml')} disabled={exporting}>
          <Text style={s.exportBtnText}>{exporting ? '…' : 'Export KML'}</Text>
        </TouchableOpacity>
      </View>

      {/* Waypoint list */}
      {waypoints.length === 0 ? (
        <View style={s.empty}>
          <Text style={s.emptyText}>No waypoints yet.{'\n'}Go to Survey tab to save points.</Text>
        </View>
      ) : (
        <FlatList
          data={[...waypoints].reverse()}
          keyExtractor={(wp) => String(wp.id)}
          renderItem={({ item }) => <WaypointItem wp={item} />}
          contentContainerStyle={{ paddingBottom: 16 }}
        />
      )}

      {/* Clear button */}
      {waypoints.length > 0 && (
        <TouchableOpacity style={s.clearBtn} onPress={handleClear}>
          <Text style={s.clearBtnText}>Clear all</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, paddingBottom: 8 },
  headerText: { fontSize: 16, fontWeight: '700', color: C.text },
  syncBtn: { backgroundColor: C.card, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12 },
  syncBtnText: { fontSize: 13, color: C.accent, fontWeight: '600' },
  exportRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 12 },
  exportBtn: { flex: 1, borderRadius: 10, padding: 12, alignItems: 'center' },
  exportBtnText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: C.muted, fontSize: 15, textAlign: 'center', lineHeight: 24 },
  item: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card,
    marginHorizontal: 16, marginBottom: 8, borderRadius: 10, padding: 12 },
  itemLeft: { flex: 1 },
  itemLabel: { fontSize: 16, fontWeight: '800', color: C.text },
  itemCoords: { fontSize: 12, color: C.muted, marginTop: 2 },
  itemMeta: { fontSize: 11, color: C.muted, marginTop: 2 },
  accDot: { borderRadius: 8, paddingVertical: 4, paddingHorizontal: 8, marginLeft: 8 },
  accDotText: { color: '#fff', fontWeight: '700', fontSize: 12 },
  clearBtn: { margin: 16, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: C.red, alignItems: 'center' },
  clearBtnText: { color: C.red, fontWeight: '700', fontSize: 14 },
});
