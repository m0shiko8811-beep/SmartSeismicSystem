import { UTMResult } from '../types/gps';

export function hdopToAccuracy(hdop: number): number {
  return hdop * 2.5;
}

export function isAccuracyInRange(acc: number, minAcc: number, maxAcc: number): boolean {
  if (acc <= 0) return false;
  if (minAcc > 0 && acc < minAcc) return false;
  if (maxAcc > 0 && acc > maxAcc) return false;
  return true;
}

export function haversineDist(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
  const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
    Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

export function formatDist(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(1)} m`;
}

export function latLonToUTM(lat: number, lon: number): UTMResult {
  const a = 6378137.0, f = 1 / 298.257223563;
  const b = a * (1 - f), e2 = 1 - (b * b) / (a * a);
  const k0 = 0.9996;
  const zone = Math.floor((lon + 180) / 6) + 1;
  const lon0 = (zone - 1) * 6 - 180 + 3;
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
  const easting = k0 * N * (A + (1 - T + C) * A ** 3 / 6 +
    (5 - 18 * T + T * T + 72 * C - 58 * (e2 / (1 - e2))) * A ** 5 / 120) + 500000;
  const northing = k0 * (M + N * Math.tan(latR) * (A * A / 2 +
    (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 +
    (61 - 58 * T + T * T + 600 * C - 330 * (e2 / (1 - e2))) * A ** 6 / 720)) +
    (lat < 0 ? 10000000 : 0);
  const bands = 'CDEFGHJKLMNPQRSTUVWX';
  const band = bands[Math.floor((lat + 80) / 8)] || 'Z';
  return {
    zone, band, easting: Math.round(easting), northing: Math.round(northing),
    label: `${zone}${band}`,
  };
}

interface FixInfo {
  name: string;
  desc: string;
  accuracy: string;
  color: string;
}

const FIX_INFO: Record<number, FixInfo> = {
  0: { name: 'No Fix',          desc: 'No satellites locked',                      accuracy: '—',        color: '#D50000' },
  1: { name: 'Standard GPS',    desc: 'Uncorrected GPS signal',                    accuracy: '~3–5 m',   color: '#FF6D00' },
  2: { name: 'DGPS / SBAS',     desc: 'Satellite-based differential corrections',  accuracy: '~1–2 m',   color: '#FFD600' },
  3: { name: 'PPS',             desc: 'Precise Positioning Service',               accuracy: '~1 m',     color: '#FFD600' },
  4: { name: 'RTK Fixed',       desc: 'Full RTK — integer ambiguity resolved',     accuracy: '< 3 cm',   color: '#00C853' },
  5: { name: 'RTK Float',       desc: 'RTK converging — ambiguity not yet fixed',  accuracy: '~10–50 cm',color: '#64DD17' },
  6: { name: 'Dead Reckoning',  desc: 'Estimated from last known position',        accuracy: 'Unknown',  color: '#9E9E9E' },
};

export function fixQualityInfo(q: number): FixInfo {
  return FIX_INFO[q] ?? { name: 'Unknown', desc: 'Unknown fix type', accuracy: '—', color: '#9E9E9E' };
}

export function fixQualityName(q: number): string  { return fixQualityInfo(q).name; }
export function fixQualityColor(q: number): string { return fixQualityInfo(q).color; }
