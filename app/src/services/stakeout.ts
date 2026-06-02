import AsyncStorage from '@react-native-async-storage/async-storage';

export interface StakeoutTarget {
  label: string;
  lat: number;
  lon: number;
  notes?: string;
}

export function parseStakeoutCSV(csv: string): StakeoutTarget[] {
  const lines = csv.trim().split(/\r?\n/);
  const result: StakeoutTarget[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(',').map(p => p.trim().replace(/^["']|["']$/g, ''));
    if (parts.length < 3) continue;
    const lat = parseFloat(parts[1]);
    const lon = parseFloat(parts[2]);
    if (!isFinite(lat) || !isFinite(lon)) continue; // skips header row too
    result.push({ label: parts[0] || `P${result.length + 1}`, lat, lon, notes: parts[3] });
  }
  return result;
}

const TARGETS_KEY = 'stakeout_targets';
const IDX_KEY     = 'stakeout_idx';

export async function loadStakeout(): Promise<StakeoutTarget[]> {
  const v = await AsyncStorage.getItem(TARGETS_KEY);
  if (!v) return [];
  try { return JSON.parse(v); } catch { return []; }
}

export async function saveStakeout(targets: StakeoutTarget[]): Promise<void> {
  await AsyncStorage.setItem(TARGETS_KEY, JSON.stringify(targets));
}

export async function loadStakeoutIdx(): Promise<number> {
  const v = await AsyncStorage.getItem(IDX_KEY);
  return v != null ? (parseInt(v) || 0) : 0;
}

export async function saveStakeoutIdx(idx: number): Promise<void> {
  await AsyncStorage.setItem(IDX_KEY, String(idx));
}
