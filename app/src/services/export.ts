import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Waypoint } from '../types/gps';
import { latLonToUTM, latLonToITM, hdopToAccuracy, fixQualityName } from './calculations';

// ── Coordinate projection ─────────────────────────────────────────────────────

export interface EpsgOption {
  code: number;
  label: string;
  xHeader: string;
  yHeader: string;
}

export const EPSG_LIST: EpsgOption[] = [
  { code: 4326,  label: 'WGS84 — Lat/Lon (EPSG:4326)',        xHeader: 'Longitude',  yHeader: 'Latitude'  },
  { code: 2039,  label: 'ITM — Israel national grid (2039)',   xHeader: 'ITM_E',      yHeader: 'ITM_N'     },
  { code: 32636, label: 'UTM Zone 36N — WGS84 (EPSG:32636)',  xHeader: 'UTM36N_E',   yHeader: 'UTM36N_N'  },
  { code: 32637, label: 'UTM Zone 37N — WGS84 (EPSG:32637)',  xHeader: 'UTM37N_E',   yHeader: 'UTM37N_N'  },
  { code: 32635, label: 'UTM Zone 35N — WGS84 (EPSG:32635)',  xHeader: 'UTM35N_E',   yHeader: 'UTM35N_N'  },
  { code: 32634, label: 'UTM Zone 34N — WGS84 (EPSG:32634)',  xHeader: 'UTM34N_E',   yHeader: 'UTM34N_N'  },
  { code: 25832, label: 'ETRS89 / UTM Zone 32N (EPSG:25832)', xHeader: 'ETRS32N_E',  yHeader: 'ETRS32N_N' },
  { code: 3857,  label: 'Web Mercator (EPSG:3857)',            xHeader: 'WebMerc_X',  yHeader: 'WebMerc_Y' },
];

function utmProject(lat: number, lon: number, forceZone: number): { x: number; y: number } {
  const a = 6378137.0, f = 1 / 298.257223563;
  const b = a * (1 - f), e2 = 1 - (b * b) / (a * a);
  const k0 = 0.9996;
  const lon0 = (forceZone - 1) * 6 - 180 + 3;
  const latR = lat * Math.PI / 180;
  const lonR = lon * Math.PI / 180;
  const lon0R = lon0 * Math.PI / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(latR) ** 2);
  const T = Math.tan(latR) ** 2;
  const C = (e2 / (1 - e2)) * Math.cos(latR) ** 2;
  const A = Math.cos(latR) * (lonR - lon0R);
  const e4 = e2 * e2, e6 = e4 * e2;
  const M = a * ((1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * latR
    - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * latR)
    + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * latR)
    - 35 * e6 / 3072 * Math.sin(6 * latR));
  const x = k0 * N * (A + (1 - T + C) * A ** 3 / 6 +
    (5 - 18 * T + T * T + 72 * C - 58 * (e2 / (1 - e2))) * A ** 5 / 120) + 500000;
  const y = k0 * (M + N * Math.tan(latR) * (A * A / 2 +
    (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 +
    (61 - 58 * T + T * T + 600 * C - 330 * (e2 / (1 - e2))) * A ** 6 / 720)) +
    (lat < 0 ? 10000000 : 0);
  return { x: Math.round(x), y: Math.round(y) };
}

function webMercator(lat: number, lon: number): { x: number; y: number } {
  const R = 6378137.0;
  const x = lon * Math.PI / 180 * R;
  const y = Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * R;
  return { x: Math.round(x), y: Math.round(y) };
}

function projectPoint(lat: number, lon: number, epsgCode: number): { x: number | string; y: number | string } {
  switch (epsgCode) {
    case 4326:  return { x: lon.toFixed(7), y: lat.toFixed(7) };
    case 2039:  { const r = latLonToITM(lat, lon); return { x: r.easting, y: r.northing }; }
    case 32636: return utmProject(lat, lon, 36);
    case 32637: return utmProject(lat, lon, 37);
    case 32635: return utmProject(lat, lon, 35);
    case 32634: return utmProject(lat, lon, 34);
    case 25832: return utmProject(lat, lon, 32);  // GRS80 ≈ WGS84 for practical purposes
    case 3857:  return webMercator(lat, lon);
    default:    return { x: lon.toFixed(7), y: lat.toFixed(7) };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function csvField(v: string | number): string {
  return `"${String(v).replace(/"/g, '""')}"`;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ── CSV generation ────────────────────────────────────────────────────────────

function timestamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}_${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}`;
}

export function generateCSV(waypoints: Waypoint[]): string {
  const header = 'Label,Latitude,Longitude,Altitude_m,UTM_Zone,UTM_E,UTM_N,ITM_E,ITM_N,DateTime,Est_Acc_m,HDOP,Fix_Quality';
  const rows = waypoints.map(wp => {
    const utm = latLonToUTM(wp.lat, wp.lon);
    const itm = latLonToITM(wp.lat, wp.lon);
    const acc = hdopToAccuracy(wp.hdop, wp.fixQ).toFixed(2);
    const fq = fixQualityName(wp.fixQ);
    return [
      csvField(wp.label), wp.lat.toFixed(7), wp.lon.toFixed(7), wp.alt.toFixed(2),
      csvField(utm.label), utm.easting, utm.northing,
      itm.easting, itm.northing,
      csvField(wp.ts), acc, wp.hdop.toFixed(2), csvField(fq),
    ].join(',');
  });
  return [header, ...rows].join('\n');
}

export function generateCSVWithProjection(waypoints: Waypoint[], epsg: EpsgOption): string {
  const header = `Label,Latitude,Longitude,Altitude_m,${epsg.xHeader},${epsg.yHeader},DateTime,Est_Acc_m,HDOP,Fix_Quality`;
  const rows = waypoints.map(wp => {
    const { x, y } = projectPoint(wp.lat, wp.lon, epsg.code);
    const acc = hdopToAccuracy(wp.hdop, wp.fixQ).toFixed(2);
    const fq = fixQualityName(wp.fixQ);
    return [
      csvField(wp.label), wp.lat.toFixed(7), wp.lon.toFixed(7), wp.alt.toFixed(2),
      x, y,
      csvField(wp.ts), acc, wp.hdop.toFixed(2), csvField(fq),
    ].join(',');
  });
  return [header, ...rows].join('\n');
}

export function generateKML(waypoints: Waypoint[]): string {
  const placemarks = waypoints.map(wp => `  <Placemark>
    <name>${xmlEscape(wp.label)}</name>
    <description>Alt: ${wp.alt.toFixed(1)}m | HDOP: ${wp.hdop.toFixed(2)} | ${xmlEscape(wp.ts)}</description>
    <Point><coordinates>${wp.lon.toFixed(7)},${wp.lat.toFixed(7)},${wp.alt.toFixed(2)}</coordinates></Point>
  </Placemark>`).join('\n');
  const coords = waypoints.map(wp => `${wp.lon.toFixed(7)},${wp.lat.toFixed(7)},${wp.alt.toFixed(2)}`).join(' ');
  const line = waypoints.length > 1 ? `  <Placemark>
    <name>Survey Line</name>
    <LineString><altitudeMode>absolute</altitudeMode><coordinates>${coords}</coordinates></LineString>
  </Placemark>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>GPS Survey</name>
${placemarks}
${line}
</Document>
</kml>`;
}

export async function exportAndShare(waypoints: Waypoint[], format: 'csv' | 'kml', epsg?: EpsgOption): Promise<void> {
  if (waypoints.length === 0) throw new Error('No waypoints to export');
  const ts = timestamp();
  let content: string;
  let ext: string;
  let mime: string;
  if (format === 'kml') {
    content = generateKML(waypoints);
    ext = 'kml';
    mime = 'application/vnd.google-earth.kml+xml';
  } else if (epsg && epsg.code !== 4326) {
    content = generateCSVWithProjection(waypoints, epsg);
    ext = 'csv';
    mime = 'text/csv';
  } else {
    content = generateCSV(waypoints);
    ext = 'csv';
    mime = 'text/csv';
  }
  const path = `${FileSystem.documentDirectory}survey_${ts}.${ext}`;
  await FileSystem.writeAsStringAsync(path, content, { encoding: FileSystem.EncodingType.UTF8 });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(path, { mimeType: mime, dialogTitle: `Share survey_${ts}.${ext}` });
  } else {
    throw new Error('Sharing not available on this device');
  }
}
