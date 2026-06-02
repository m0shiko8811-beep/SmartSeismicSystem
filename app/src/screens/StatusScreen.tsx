import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Text as SvgText } from 'react-native-svg';
import { useGps } from '../context/GpsContext';
import { latLonToUTM, latLonToITM, hdopToAccuracy, fixQualityInfo, correctionSource } from '../services/calculations';
import { SatInfo } from '../types/gps';
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

const FIX_BAR_COLORS: Record<number, string> = {
  0: '#424242', 1: '#FF6D00', 2: '#FFD600', 3: '#FFD600', 4: '#00C853', 5: '#64DD17',
};

function FixHistoryChart({ history }: { history: number[] }) {
  if (history.length === 0) return null;
  return (
    <View style={s.chartWrap}>
      <Text style={s.chartLabel}>Fix quality — last {history.length}s</Text>
      <View style={s.chartBars}>
        {history.map((q, i) => (
          <View key={i} style={[s.chartBar, { backgroundColor: FIX_BAR_COLORS[q] ?? '#424242' }]} />
        ))}
      </View>
      <View style={s.chartLegend}>
        <Text style={[s.legendDot, { color: FIX_BAR_COLORS[0] }]}>■ No fix</Text>
        <Text style={[s.legendDot, { color: FIX_BAR_COLORS[1] }]}>■ GPS</Text>
        <Text style={[s.legendDot, { color: FIX_BAR_COLORS[2] }]}>■ DGPS</Text>
        <Text style={[s.legendDot, { color: FIX_BAR_COLORS[5] }]}>■ Float</Text>
        <Text style={[s.legendDot, { color: FIX_BAR_COLORS[4] }]}>■ Fixed</Text>
      </View>
    </View>
  );
}

function snrColor(snr: number): string {
  if (snr >= 40) return '#00C853';
  if (snr >= 25) return '#FFD600';
  if (snr > 0)  return '#FF6D00';
  return '#616161';
}

function SkyplotChart({ satellites }: { satellites: SatInfo[] }) {
  if (satellites.length === 0) return null;
  const SIZE = 200;
  const CX = SIZE / 2, CY = SIZE / 2, R = SIZE / 2 - 10;

  // Convert elevation/azimuth to x/y on the polar plot
  // Elevation 90° = center, 0° = outer ring
  const satToXY = (sat: SatInfo) => {
    const r = R * (1 - sat.elev / 90);
    const θ = (sat.azim - 90) * Math.PI / 180; // azimuth: 0=N, 90=E
    return { x: CX + r * Math.cos(θ), y: CY + r * Math.sin(θ) };
  };

  const sysColors: Record<string, string> = {
    GPS: '#4FC3F7', GLONASS: '#FF8A65', Galileo: '#81C784',
    BeiDou: '#CE93D8', QZSS: '#FFD54F',
  };

  return (
    <View style={s.skyplotWrap}>
      <Text style={s.chartLabel}>Satellite skyplot ({satellites.length} tracked)</Text>
      <Svg width={SIZE} height={SIZE}>
        {/* Rings at 0°, 30°, 60° elevation */}
        {[0, 30, 60].map(elev => (
          <Circle key={elev} cx={CX} cy={CY}
            r={R * (1 - elev / 90)}
            stroke="#333" strokeWidth={1} fill="none" />
        ))}
        {/* N/S/E/W cardinal labels */}
        <SvgText x={CX} y={8} fill="#555" fontSize={9} textAnchor="middle">N</SvgText>
        <SvgText x={CX} y={SIZE - 2} fill="#555" fontSize={9} textAnchor="middle">S</SvgText>
        <SvgText x={SIZE - 4} y={CY + 4} fill="#555" fontSize={9} textAnchor="middle">E</SvgText>
        <SvgText x={4} y={CY + 4} fill="#555" fontSize={9} textAnchor="middle">W</SvgText>
        {/* Cross lines */}
        <Line x1={CX} y1={10} x2={CX} y2={SIZE - 10} stroke="#333" strokeWidth={0.5} />
        <Line x1={10} y1={CY} x2={SIZE - 10} y2={CY} stroke="#333" strokeWidth={0.5} />
        {/* Satellites */}
        {satellites.map((sat, i) => {
          const { x, y } = satToXY(sat);
          const color = snrColor(sat.snr);
          const sysColor = sysColors[sat.system] ?? '#9E9E9E';
          return (
            <React.Fragment key={i}>
              <Circle cx={x} cy={y} r={7} fill={color} opacity={0.85} stroke={sysColor} strokeWidth={1.5} />
              <SvgText x={x} y={y + 3.5} fill="#fff" fontSize={6} fontWeight="bold" textAnchor="middle">
                {sat.prn}
              </SvgText>
            </React.Fragment>
          );
        })}
      </Svg>
      {/* Legend */}
      <View style={s.skyLegend}>
        <Text style={[s.skyLegendItem, { color: '#00C853' }]}>● SNR≥40</Text>
        <Text style={[s.skyLegendItem, { color: '#FFD600' }]}>● SNR≥25</Text>
        <Text style={[s.skyLegendItem, { color: '#FF6D00' }]}>● SNR&lt;25</Text>
        <Text style={[s.skyLegendItem, { color: '#616161' }]}>● No signal</Text>
      </View>
      <View style={s.skyLegend}>
        {Object.entries({ GPS: '#4FC3F7', GLONASS: '#FF8A65', Galileo: '#81C784', BeiDou: '#CE93D8' }).map(([sys, col]) => (
          <Text key={sys} style={[s.skyLegendItem, { color: col }]}>○ {sys}</Text>
        ))}
      </View>
    </View>
  );
}

export default function StatusScreen() {
  const { gps, bleStatus, ntripConnState, ntripKB } = useGps();
  const [fixHistory, setFixHistory] = useState<number[]>([]);

  useEffect(() => {
    if (gps?.fixQ !== undefined) {
      setFixHistory(prev => {
        const next = [...prev, gps.fix ? gps.fixQ : 0];
        return next.length > 90 ? next.slice(-90) : next;
      });
    }
  }, [gps?.lat, gps?.fix, gps?.fixQ]);

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
      <View style={[s.badge, { backgroundColor: wsBadge.bg }]}>
        <Text style={s.badgeText}>{wsBadge.text}</Text>
      </View>

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
        <FixHistoryChart history={fixHistory} />
        {gps.satellites && gps.satellites.length > 0 && (
          <SkyplotChart satellites={gps.satellites} />
        )}
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
  // Fix history chart
  chartWrap: { marginTop: 14 },
  chartLabel: { fontSize: 10, color: C.muted, marginBottom: 4 },
  chartBars: { flexDirection: 'row', height: 28, gap: 1, alignItems: 'flex-end' },
  chartBar: { flex: 1, height: 28, borderRadius: 1 },
  chartLegend: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 5 },
  legendDot: { fontSize: 10, fontWeight: '700' },
  // Skyplot
  skyplotWrap: { marginTop: 16, alignItems: 'center' },
  skyLegend: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4, justifyContent: 'center' },
  skyLegendItem: { fontSize: 9, fontWeight: '700' },
});
