import AsyncStorage from '@react-native-async-storage/async-storage';

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

export async function loadNtripConfigs(): Promise<NtripSavedConfig[]> {
  try {
    const raw = await AsyncStorage.getItem(NTRIP_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function saveNtripConfigs(configs: NtripSavedConfig[]): Promise<void> {
  await AsyncStorage.setItem(NTRIP_KEY, JSON.stringify(configs));
}
