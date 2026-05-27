import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useGps } from '../context/GpsContext';
import { latLonToUTM, latLonToITM, hdopToAccuracy, fixQualityInfo, correctionSource } from '../services/calculations';
import { C } from '../theme';

function Row({ label, value }: { label: string; value: string | React.ReactNode }) {
  return (
    <View style={s.row}>
      <Text style={s.label}>{label}</Text>
      {typeof value === 'string' ? <Text style={s.value}>{value}</Text> : value}
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

export default function StatusScreen() {
  const { gps, bleStatus, ntripConnState, ntripKB } = useGps();

  const wsBadge = bleStatus === 'connected' ? { bg: C.green, text: 'BLE Connected' }
    : bleStatus === 'connecting' ? { bg: C.amber, text: 'Scanning for GPS-Survey…' }
    : { bg: C.red, text: 'BLE Disconnected' };

  if (!gps) {
    return (
      <View style={s.center}>
        <View style={[s.badge, { backgroundColor: wsBadge.bg }]}>
          <Text style={s.badgeText}>{wsBadge.text} — waiting for GPS data</Text>
        </View>
      </View>
    );
  }

  const acc = hdopToAccuracy(gps.hdop, gps.fixQ);
  const utm = gps.fix ? latLonToUTM(gps.lat, gps.lon) : null;
  const itm = gps.fix ? latLonToITM(gps.lat, gps.lon) : null;
  const hdopPct = Math.max(5, Math.min(100, Math.round((1 - (gps.hdop - 0.5) / 4.5) * 100)));
  const fixInfo = fixQualityInfo(gps.fixQ);
  const ntripBg = ntripConnState === 'streaming' ? C.green
                : ntripConnState === 'connecting' ? C.amber
                : '#374151';
  const ntripText = ntripConnState === 'streaming'
    ? `● NTRIP ACTIVE — ${ntripKB.toFixed(1)} KB received`
    : ntripConnState === 'connecting'
    ? '◌ NTRIP connecting…'
    : '○ NTRIP — not connected';

  return (
    <ScrollView style={s.scroll} contentContainerStyle={s.container}>
      {/* Connection badge */}
      <View style={[s.badge, { backgroundColor: wsBadge.bg }]}>
        <Text style={s.badgeText}>{wsBadge.text}</Text>
      </View>

      {/* NTRIP status — always visible */}
      <View style={[s.badge, { backgroundColor: ntripBg }]}>
        <Text style={s.badgeText}>{ntripText}</Text>
      </View>

      <Section title="Position">
        <Row label="Latitude"  value={gps.fix ? gps.lat.toFixed(7) + '°' : '—'} />
        <Row label="Longitude" value={gps.fix ? gps.lon.toFixed(7) + '°' : '—'} />
        <Row label="Altitude"  value={gps.fix ? gps.alt.toFixed(2) + ' m' : '—'} />
      </Section>

      {utm && (
        <Section title="UTM (WGS84)">
          <Row label="Zone"     value={utm.label} />
          <Row label="Easting"  value={utm.easting.toString()} />
          <Row label="Northing" value={utm.northing.toString()} />
        </Section>
      )}

      {itm && (
        <Section title="ITM (Israel)">
          <Row label="Easting"  value={itm.easting.toString()} />
          <Row label="Northing" value={itm.northing.toString()} />
        </Section>
      )}

      <Section title="Signal">
        {/* Fix quality card */}
        <View style={[s.fixCard, { borderLeftColor: fixInfo.color }]}>
          <View style={s.fixTop}>
            <View style={[s.fixBadge, { backgroundColor: fixInfo.color }]}>
              <Text style={s.fixBadgeText}>{fixInfo.name}</Text>
            </View>
            <Text style={s.fixAccuracy}>{fixInfo.accuracy}</Text>
          </View>
          <Text style={s.fixDesc}>{fixInfo.desc}</Text>
          <Text style={s.corrSrc}>{correctionSource(gps.fixQ, ntripConnState)}</Text>
        </View>
        <Row label="Satellites"    value={`${gps.sats} (used in fix)`} />
        <Row label="HDOP"          value={gps.hdop.toFixed(2)} />
        <Row label="Est. accuracy" value={acc.toFixed(2) + ' m (est.)'} />
        <View style={s.barBg}>
          <View style={[s.barFill, { width: `${hdopPct}%` as any,
            backgroundColor: hdopPct > 60 ? C.green : hdopPct > 30 ? C.amber : C.red }]} />
        </View>
      </Section>

      <Section title="Raw NMEA">
        <Text style={s.nmea}>{gps.nmea || '—'}</Text>
        <Text style={s.nmea}>{gps.gsa || '—'}</Text>
        <Text style={s.nmea}>{gps.rmc || '—'}</Text>
      </Section>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: C.bg },
  container: { padding: 16, paddingBottom: 32 },
  center: { flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', padding: 20 },
  badge: { borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12, marginBottom: 12, alignItems: 'center' },
  badgeText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  section: { backgroundColor: C.card, borderRadius: 12, padding: 14, marginBottom: 12 },
  sectionTitle: { fontSize: 11, fontWeight: '700', color: C.accent, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: C.border },
  label: { fontSize: 14, color: C.muted },
  value: { fontSize: 14, color: C.text, fontWeight: '600' },
  fixCard: { borderLeftWidth: 4, borderRadius: 8, backgroundColor: C.bg, padding: 10, marginBottom: 10 },
  fixTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  fixBadge: { borderRadius: 6, paddingHorizontal: 10, paddingVertical: 3 },
  fixBadgeText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  fixAccuracy: { fontSize: 13, fontWeight: '700', color: C.text },
  fixDesc: { fontSize: 12, color: C.muted },
  corrSrc: { fontSize: 11, color: C.accent, fontWeight: '600', marginTop: 4 },
  barBg: { height: 8, backgroundColor: C.border, borderRadius: 4, marginTop: 10, overflow: 'hidden' },
  barFill: { height: 8, borderRadius: 4 },
  nmea: { fontSize: 10, fontFamily: 'monospace', color: C.accent, marginTop: 4 },
});
