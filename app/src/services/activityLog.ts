import * as FileSystem from 'expo-file-system/legacy';

const LOG_FILE = `${FileSystem.documentDirectory}activity_log.jsonl`;

export interface LogEntry {
  ts: string;
  event: string;
  data?: Record<string, unknown>;
}

export async function appendLog(event: string, data?: Record<string, unknown>): Promise<void> {
  try {
    const entry: LogEntry = { ts: new Date().toISOString(), event, ...(data ? { data } : {}) };
    const line = JSON.stringify(entry) + '\n';
    await FileSystem.writeAsStringAsync(LOG_FILE, line, {
      encoding: FileSystem.EncodingType.UTF8,
      append: true,  // O(1) instead of O(n) read-modify-write
    } as any);
  } catch {
    // Silent — log failures must never crash the app
  }
}

export async function loadLog(): Promise<LogEntry[]> {
  try {
    const info = await FileSystem.getInfoAsync(LOG_FILE);
    if (!info.exists) return [];
    const raw = await FileSystem.readAsStringAsync(LOG_FILE, { encoding: FileSystem.EncodingType.UTF8 });
    return raw
      .split('\n')
      .filter(l => l.trim().length > 0)
      .map(l => { try { return JSON.parse(l) as LogEntry; } catch { return null; } })
      .filter((e): e is LogEntry => e !== null)
      .reverse();
  } catch {
    return [];
  }
}

export async function clearLog(): Promise<void> {
  try {
    await FileSystem.deleteAsync(LOG_FILE, { idempotent: true } as any);
  } catch {}
}

export function logFilePath(): string {
  return LOG_FILE;
}
