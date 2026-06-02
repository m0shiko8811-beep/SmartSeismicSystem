import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

export async function getAccSettings(): Promise<{ minAcc: number; maxAcc: number; accFilterEnabled: boolean }> {
  const min     = await AsyncStorage.getItem('minAcc');
  const max     = await AsyncStorage.getItem('maxAcc');
  const enabled = await AsyncStorage.getItem('accFilterEnabled');
  return {
    minAcc:           parseFloat(min ?? '0'),
    maxAcc:           parseFloat(max ?? '10'),
    accFilterEnabled: enabled !== 'false',
  };
}

export async function setAccSettings(minAcc: number, maxAcc: number, accFilterEnabled: boolean): Promise<void> {
  await AsyncStorage.setItem('minAcc',           String(minAcc));
  await AsyncStorage.setItem('maxAcc',           String(maxAcc));
  await AsyncStorage.setItem('accFilterEnabled', String(accFilterEnabled));
}

const NTRIP_KEY = 'ntrip_configs';

export interface NtripSavedConfig {
  name: string;
  host: string;
  port: string;
  mnt: string;
  usr: string;
  pwd: string;
}

// NTRIP presets contain credentials, so they live in the OS keystore
// (expo-secure-store) instead of plaintext AsyncStorage. Any pre-existing
// plaintext copy is migrated into the keystore and deleted on first load.
export async function loadNtripConfigs(): Promise<NtripSavedConfig[]> {
  try {
    let raw = await SecureStore.getItemAsync(NTRIP_KEY);
    if (raw == null) {
      const legacy = await AsyncStorage.getItem(NTRIP_KEY);
      if (legacy != null) {
        try { await SecureStore.setItemAsync(NTRIP_KEY, legacy); } catch {}
        await AsyncStorage.removeItem(NTRIP_KEY); // remove the plaintext copy
        raw = legacy;
      }
    }
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function saveNtripConfigs(configs: NtripSavedConfig[]): Promise<void> {
  // SecureStore values are ~2 KB max on Android — fine for a handful of presets.
  await SecureStore.setItemAsync(NTRIP_KEY, JSON.stringify(configs));
}

export interface BuiltinNtripService {
  name: string;
  detail: string;
  host: string;
  port: string;
  mnt: string;
  usr: string;
  pwd: string;
  usrPlaceholder?: string;
}

export const BUILTIN_NTRIP_SERVICES: BuiltinNtripService[] = [
  {
    name: 'Centipede RTK — ARKG',
    detail: 'crtk.net · Israel (Kfar Misgav, 32.65°N 35.29°E) · RTCM3 GAL+BDS L1/L2',
    host: 'crtk.net', port: '2101', mnt: 'ARKG',
    usr: 'centipede', pwd: 'centipede',
  },
  {
    name: 'Centipede RTK — NEAR',
    detail: 'crtk.net · Auto-selects nearest base station · Login: centipede / centipede',
    host: 'crtk.net', port: '2101', mnt: 'NEAR',
    usr: 'centipede', pwd: 'centipede',
  },
  {
    name: 'RTK2Go — Misgav Dov',
    detail: 'rtk2go.com · Free public caster · Use your email as username, password: none',
    host: 'rtk2go.com', port: '2101', mnt: 'MisgavDov',
    usr: '', pwd: 'none',
    usrPlaceholder: 'your-email@example.com',
  },
];
