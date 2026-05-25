import AsyncStorage from '@react-native-async-storage/async-storage';
import { Waypoint } from '../types/gps';

const KEY = 'gps_wps';

export async function loadWaypoints(): Promise<Waypoint[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function saveWaypoints(wps: Waypoint[]): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(wps));
}

export async function appendWaypoint(wp: Waypoint): Promise<Waypoint[]> {
  const wps = await loadWaypoints();
  const updated = [...wps, wp];
  await saveWaypoints(updated);
  return updated;
}

export async function clearWaypoints(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}

export async function getAccSettings(): Promise<{ minAcc: number; maxAcc: number }> {
  const min = await AsyncStorage.getItem('minAcc');
  const max = await AsyncStorage.getItem('maxAcc');
  return { minAcc: parseFloat(min ?? '0'), maxAcc: parseFloat(max ?? '10') };
}

export async function setAccSettings(minAcc: number, maxAcc: number): Promise<void> {
  await AsyncStorage.setItem('minAcc', String(minAcc));
  await AsyncStorage.setItem('maxAcc', String(maxAcc));
}
