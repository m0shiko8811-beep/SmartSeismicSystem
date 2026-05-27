import { UTMResult } from '../types/gps';

export function hdopToAccuracy(hdop: number, fixQ: number = 1): number {
  // RTK accuracy is determined by ambiguity resolution, not satellite geometry (HDOP)
  if (fixQ === 4) return 0.02;   // RTK Fixed: ~2 cm fixed estimate
  if (fixQ === 5) return 0.25;   // RTK Float: ~25 cm fixed conservative estimate
  const uere = fixQ === 2 ? 0.60
             : fixQ === 1 ? 1.50
             : 5.0;
  return hdop * uere;
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
    label: `${zone}${lat >= 0 ? 'N' : 'S'}`,
  };
}

export interface ITMResult {
  easting: number;
  northing: number;
}

export function latLonToITM(lat: number, lon: number): ITMResult {
  // Israeli Transverse Mercator — EPSG:2039, GRS80 ellipsoid
  const a = 6378137.0, f = 1 / 298.257222101;
  const b = a * (1 - f);
  const e2 = 1 - (b * b) / (a * a);
  const k0 = 1.0000067;
  const lat0 = 31.7343936111111 * Math.PI / 180;
  const lon0 = 35.2045169444444 * Math.PI / 180;
  const fe = 219529.584, fn = 626907.390;
  const latR = lat * Math.PI / 180;
  const lonR = lon * Math.PI / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(latR) ** 2);
  const T = Math.tan(latR) ** 2;
  const C = (e2 / (1 - e2)) * Math.cos(latR) ** 2;
  const Av = Math.cos(latR) * (lonR - lon0);
  const e4 = e2 * e2, e6 = e4 * e2;
  const calcM = (phi: number) =>
    a * ((1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi
      - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi)
      + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi)
      - 35 * e6 / 3072 * Math.sin(6 * phi));
  const M = calcM(latR);
  const M0 = calcM(lat0);
  const easting = fe + k0 * N * (Av + (1 - T + C) * Av ** 3 / 6 +
    (5 - 18 * T + T * T + 72 * C - 58 * (e2 / (1 - e2))) * Av ** 5 / 120);
  const northing = fn + k0 * ((M - M0) + N * Math.tan(latR) * (Av * Av / 2 +
    (5 - T + 9 * C + 4 * C * C) * Av ** 4 / 24 +
    (61 - 58 * T + T * T + 600 * C - 330 * (e2 / (1 - e2))) * Av ** 6 / 720));
  return { easting: Math.round(easting), northing: Math.round(northing) };
}

export function correctionSource(fixQ: number, ntripState: 'idle' | 'connecting' | 'streaming' | 'error'): string {
  const ntrip = ntripState === 'streaming';
  if (fixQ === 0) return 'No fix';
  if (fixQ === 1) return 'Uncorrected GPS';
  if (fixQ === 2) return ntrip ? 'NTRIP DGPS corrections' : 'SBAS / satellite corrections';
  if (fixQ === 3) return 'PPS signal';
  if (fixQ === 4) return ntrip ? 'RTK Fixed — via NTRIP' : 'RTK Fixed';
  if (fixQ === 5) return ntrip ? 'RTK Float — converging via NTRIP' : 'RTK Float — converging';
  return 'Unknown';
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
  4: { name: 'RTK Fixed',       desc: 'Full RTK — integer ambiguity resolved',     accuracy: '~2 cm',    color: '#00C853' },
  5: { name: 'RTK Float',       desc: 'RTK converging — ambiguity not yet fixed',  accuracy: '~25 cm',   color: '#64DD17' },
  6: { name: 'Dead Reckoning',  desc: 'Estimated from last known position',        accuracy: 'Unknown',  color: '#9E9E9E' },
};

export function fixQualityInfo(q: number): FixInfo {
  return FIX_INFO[q] ?? { name: 'Unknown', desc: 'Unknown fix type', accuracy: '—', color: '#9E9E9E' };
}

export function fixQualityName(q: number): string  { return fixQualityInfo(q).name; }
export function fixQualityColor(q: number): string { return fixQualityInfo(q).color; }
