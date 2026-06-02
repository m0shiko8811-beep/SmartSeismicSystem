import * as FileSystem from 'expo-file-system/legacy';

const NMEA_FILE = `${FileSystem.documentDirectory}nmea_log.nmea`;

// expo-file-system's writeAsStringAsync has no real "append" option (the old
// `{ append: true } as any` was a silent no-op, so the log only ever kept the
// last write). We batch incoming sentences in memory and flush them with a
// single-flight read-concat-write on a timer — this actually appends and also
// removes the overlapping fire-and-forget writes from the per-message caller.
let _buf = '';
let _flushing = false;
let _timer: ReturnType<typeof setTimeout> | null = null;

export async function appendNmea(gga: string, gsa: string, rmc: string): Promise<void> {
  const lines = [gga, gsa, rmc].filter(l => l && l.length > 3).join('\r\n');
  if (!lines) return;
  _buf += lines + '\r\n';
  if (!_timer) _timer = setTimeout(() => { _timer = null; void flush(); }, 3000);
}

async function flush(): Promise<void> {
  if (_flushing || !_buf) return;
  _flushing = true;
  const chunk = _buf;
  _buf = '';
  try {
    let existing = '';
    const info = await FileSystem.getInfoAsync(NMEA_FILE);
    if (info.exists) existing = await FileSystem.readAsStringAsync(NMEA_FILE);
    await FileSystem.writeAsStringAsync(NMEA_FILE, existing + chunk, {
      encoding: FileSystem.EncodingType.UTF8,
    });
  } catch {
    _buf = chunk + _buf; // re-queue on failure so nothing is lost
  } finally {
    _flushing = false;
  }
}

export async function clearNmeaLog(): Promise<void> {
  _buf = '';
  if (_timer) { clearTimeout(_timer); _timer = null; }
  try { await FileSystem.deleteAsync(NMEA_FILE, { idempotent: true } as any); } catch {}
}

export function nmeaLogPath(): string { return NMEA_FILE; }

export async function getNmeaLogInfo(): Promise<{ exists: boolean; size: number }> {
  try {
    const info = await FileSystem.getInfoAsync(NMEA_FILE);
    if (!info.exists) return { exists: false, size: 0 };
    return { exists: true, size: (info as any).size ?? 0 };
  } catch {
    return { exists: false, size: 0 };
  }
}
