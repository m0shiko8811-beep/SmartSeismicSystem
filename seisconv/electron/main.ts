// SeisConv — Electron main process.
//
// Owns the window + native dialogs and drives ONE long-lived worker thread that
// holds the parsed file and answers view/convert requests. The renderer is
// sandboxed (contextIsolation, no nodeIntegration); it reaches privileged work
// only through the typed `seisconvAPI` in preload.

import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import * as dgram from 'node:dgram';
import * as path from 'node:path';
import JSZip from 'jszip';

const WORKER_PATH = path.join(__dirname, 'parse.worker.js');

const SEISMIC_FILTERS = [
  { name: 'Seismic files', extensions: ['segy', 'sgy', 'segd', 'seg', 'su', 'seg2', 'dat', 'bat'] },
  { name: 'All files', extensions: ['*'] },
];

// Input-folder enumeration: extensions (lower-case, no dot) we treat as seismic.
const INPUT_EXTS = new Set(['.segy', '.sgy', '.segd', '.seg', '.seg2', '.dat', '.bat', '.su']);

let win: BrowserWindow | null = null;
let lastOpenedPath = '';

// Sibling-file navigation state: the sorted list of seismic files in the
// CURRENTLY-open file's containing directory, plus the open file's index into
// it. Rebuilt every time a file is opened (open dialog OR sibling step), so
// Prev/Next can flip through neighbours without re-opening the picker.
let siblingPaths: string[] = [];
let siblingIndex = -1;

// Allowlist of file paths the USER has chosen via a native dialog (or that we
// enumerated from a user-chosen folder). extractTrace/getSection-style handlers
// read arbitrary renderer-supplied paths; confining them to this set stops a
// compromised renderer from reading files the user never selected. Normalized
// with path.resolve so '.'/'..'/separator variants can't slip past the check.
const authorizedPaths = new Set<string>();
function authorizePath(p: string): string {
  const abs = path.resolve(p);
  authorizedPaths.add(abs);
  return abs;
}
function isAuthorizedPath(p: string): boolean {
  return typeof p === 'string' && authorizedPaths.has(path.resolve(p));
}

// Allowlist of OUTPUT directories the user has chosen via the folder picker.
// batchConvert writes attacker-influenceable bytes (templated names) into its
// outDir, so confining writes to a user-picked directory stops a compromised
// renderer from dropping files into e.g. the Startup folder.
const authorizedDirs = new Set<string>();
function authorizeDir(p: string): string {
  const abs = path.resolve(p);
  authorizedDirs.add(abs);
  return abs;
}
function isAuthorizedDir(p: string): boolean {
  return typeof p === 'string' && authorizedDirs.has(path.resolve(p));
}

// Enumerate the seismic siblings of `filePath` (same directory), sorted by name,
// and remember the open file's position. Best-effort: on any fs error we fall
// back to a one-element list containing just the open file so navigation is a
// no-op rather than a crash.
async function indexSiblings(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const names = entries
      .filter((e) => e.isFile() && INPUT_EXTS.has(path.extname(e.name).toLowerCase()))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    siblingPaths = names.map((n) => path.join(dir, n));
  } catch {
    siblingPaths = [];
  }
  // Every enumerated sibling is reachable via Prev/Next, so authorize them all.
  for (const p of siblingPaths) authorizePath(p);
  // Locate the open file in the list; if it (somehow) isn't present, seed the
  // list with just it so index/count stay coherent.
  let idx = siblingPaths.indexOf(filePath);
  if (idx < 0) {
    siblingPaths = [filePath];
    idx = 0;
  }
  siblingIndex = idx;
}

// Build the standard open-summary envelope (path/name + nav fields + worker
// summary), shared by openAndParse and openSiblingFile so the UI can label the
// first-opened file exactly like a stepped-to one.
function openEnvelope(filePath: string, summary: any) {
  const count = siblingPaths.length;
  const index = siblingIndex;
  return {
    path: filePath,
    name: path.basename(filePath),
    index,
    count,
    hasPrev: index > 0,
    hasNext: index >= 0 && index < count - 1,
    ...summary,
  };
}

// Set true by a cancel signal; the running batch checks it between files.
let cancelRequested = false;
ipcMain.on('seisconv:cancelConvert', () => {
  cancelRequested = true;
});

// ── Persistent worker with id-correlated request/response ──
let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(WORKER_PATH);
  w.on('message', (msg: { id: number }) => {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      p.resolve(msg);
    }
  });
  const fail = (err: unknown) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    worker = null;
  };
  w.on('error', fail);
  w.on('exit', () => {
    if (worker === w) worker = null;
  });
  worker = w;
  return w;
}

function callWorker<T = any>(req: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
  const w = getWorker();
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ ...req, id }, transfer as any);
  });
}

// ── SNTP (NTP-over-UDP) client for the Observer Log "Sync clock" control ──
//
// Minimal RFC-4330 SNTP query: send a 48-byte request (LI=0, VN=4, Mode=3 client)
// to <server>:123 over UDP, read the server's TRANSMIT timestamp from the reply,
// and return offsetMs = serverTimeMs - Date.now(). No round-trip delay correction
// — the log only needs the wall-clock offset, not sub-ms precision. Resolves a
// clean error (never throws/rejects) on timeout, DNS failure, or offline so the
// renderer can surface "sync failed" without crashing. 2-second hard timeout.
const NTP_UNIX_EPOCH_DIFF = 2208988800; // seconds between 1900-01-01 and 1970-01-01

// Reject SNTP targets that point at the local machine / private networks so a
// compromised renderer can't drive the main process to probe internal hosts
// over UDP/123 (an SSRF the sandboxed renderer itself could never perform). We
// only block obviously-internal LITERALS (loopback, RFC-1918, link-local,
// unique-local IPv6); public hostnames like pool.ntp.org are resolved normally.
function isInternalNtpHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '' || h.endsWith('.localhost')) return true;
  // IPv4 literal?
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const o = m.slice(1).map(Number);
    if (o.some((x) => x > 255)) return true; // malformed → reject
    const [a, b] = o;
    if (a === 0 || a === 127) return true;                 // this-host / loopback
    if (a === 10) return true;                              // 10/8
    if (a === 172 && b >= 16 && b <= 31) return true;       // 172.16/12
    if (a === 192 && b === 168) return true;                // 192.168/16
    if (a === 169 && b === 254) return true;                // link-local
    if (a >= 224) return true;                              // multicast/reserved
    return false;
  }
  // IPv6 literal: block loopback (::1), unspecified (::), unique-local (fc00::/7),
  // and link-local (fe80::/10). Heuristic prefix check is sufficient here.
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true;
    if (/^f[cd]/.test(h)) return true; // fc00::/7 unique-local
    if (/^fe[89ab]/.test(h)) return true; // fe80::/10 link-local
    return false;
  }
  return false;
}

function sntpQuery(server: string): Promise<{ ok: boolean; offsetMs?: number; serverTimeMs?: number; error?: string }> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let done = false;
    const finish = (result: { ok: boolean; offsetMs?: number; serverTimeMs?: number; error?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'NTP request timed out' }), 2000);

    socket.on('error', (err) => finish({ ok: false, error: (err as Error).message }));
    socket.on('message', (msg) => {
      // Server transmit timestamp: 4-byte integer seconds + 4-byte fraction at
      // byte offset 40 (seconds since 1900). Need at least 48 bytes for a valid reply.
      if (msg.length < 48) { finish({ ok: false, error: 'short NTP reply' }); return; }
      const seconds = msg.readUInt32BE(40);
      const fraction = msg.readUInt32BE(44);
      const serverTimeMs = (seconds - NTP_UNIX_EPOCH_DIFF) * 1000 + Math.round((fraction / 0x100000000) * 1000);
      const offsetMs = serverTimeMs - Date.now();
      finish({ ok: true, offsetMs, serverTimeMs });
    });

    // Client request packet: first byte 0x1B = LI 0, VN 4, Mode 3 (client); rest zero.
    const packet = Buffer.alloc(48);
    packet[0] = 0x1b;
    socket.send(packet, 0, packet.length, 123, server, (err) => {
      if (err) finish({ ok: false, error: (err as Error).message });
    });
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#0d1f33',
    show: false,
    // Frameless: drop the native OS title bar AND the OS window-controls overlay
    // so the app's own header is the entire top of the window. The renderer draws
    // its own min/max/close buttons (.win-controls) that match the theme, and the
    // header acts as the drag region (-webkit-app-region:drag). titleBarStyle
    // 'hidden' with NO titleBarOverlay yields a frameless window with zero native
    // controls on Windows while keeping the rounded-corners / shadow chrome.
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win?.show());
  // Hardening: a local-only app never opens new windows or navigates elsewhere.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  // Keep the renderer's custom maximize/restore button in sync with the real
  // window state (covers OS-level maximize via Win+Up, double-click, snap, etc.).
  win.on('maximize', () => win?.webContents.send('seisconv:win-maximized', true));
  win.on('unmaximize', () => win?.webContents.send('seisconv:win-maximized', false));
  // Push the initial state once the renderer is ready to receive it.
  win.webContents.once('did-finish-load', () =>
    win?.webContents.send('seisconv:win-maximized', win.isMaximized()),
  );
  void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

// ── Custom window controls (renderer draws its own min/max/close buttons) ──
ipcMain.on('seisconv:win-minimize', () => win?.minimize());
ipcMain.on('seisconv:win-maximize-toggle', () => {
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on('seisconv:win-close', () => win?.close());

// ── IPC ──
ipcMain.handle('seisconv:openAndParse', async () => {
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: SEISMIC_FILTERS });
  if (res.canceled || !res.filePaths.length) return null;
  const filePath = res.filePaths[0];
  const r = await callWorker<{ ok: boolean; summary?: any; error?: string }>({ type: 'open', path: filePath });
  if (!r.ok) throw new Error(r.error || 'parse failed');
  lastOpenedPath = filePath;
  // Index the open file's seismic siblings so Prev/Next can step the folder.
  await indexSiblings(filePath);
  return openEnvelope(filePath, r.summary);
});

// Step to the previous/next seismic file in the open file's folder. `delta` is
// usually ±1; the target index is clamped to the list bounds. Returns null when
// the move would leave the index unchanged (already at an edge, or no file open),
// otherwise parses the target the same way as open and returns the same summary
// envelope (with updated index/count/hasPrev/hasNext).
ipcMain.handle('seisconv:openSiblingFile', async (_e, delta: number) => {
  const count = siblingPaths.length;
  if (count === 0 || siblingIndex < 0) return null;
  const d = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  const prev = siblingIndex;
  const next = Math.max(0, Math.min(count - 1, siblingIndex + d));
  if (next === siblingIndex) return null; // no move (clamped at an edge)
  const filePath = siblingPaths[next];
  // Commit the index BEFORE the await so a second fast ]/[ press reads the new
  // index and steps further, instead of both reads seeing the same stale index
  // and resolving to the same file (one keypress silently dropped). Roll back if
  // the parse fails so a failed step doesn't leave the index advanced.
  siblingIndex = next;
  let r: { ok: boolean; summary?: any; error?: string };
  try {
    r = await callWorker<{ ok: boolean; summary?: any; error?: string }>({ type: 'open', path: filePath });
  } catch (e) {
    siblingIndex = prev;
    throw e;
  }
  if (!r.ok) { siblingIndex = prev; throw new Error(r.error || 'parse failed'); }
  lastOpenedPath = filePath;
  return openEnvelope(filePath, r.summary);
});

ipcMain.handle('seisconv:getTrace', async (_e, index: number) => {
  const r = await callWorker<{ ok: boolean; error?: string } & Record<string, any>>({ type: 'trace', index });
  if (!r.ok) throw new Error(r.error || 'trace failed');
  return { index: r.index, nSamples: r.nSamples, sampleInt: r.sampleInt, hdr: r.hdr, samples: r.samples };
});

// Trace Workbench: open a single-file picker and return the chosen path WITHOUT
// parsing (the workbench parses lazily via extractTrace). Null when cancelled.
ipcMain.handle('seisconv:pickTraceFile', async () => {
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: SEISMIC_FILTERS });
  if (res.canceled || !res.filePaths.length) return null;
  return authorizePath(res.filePaths[0]);
});

// Trace Workbench: parse `path` locally (off the persistently-open file) and
// return ONE trace's samples + header. Mirrors getTrace's return shape, plus the
// source name + total trace count so the workbench can label + clamp the entry.
ipcMain.handle('seisconv:extractTrace', async (_e, filePath: string, index: number) => {
  // Only read paths the user actually chose via a dialog (or that we enumerated
  // from a user-picked folder). Blocks a compromised renderer from passing an
  // arbitrary path to readFileSync in the worker.
  if (!isAuthorizedPath(filePath)) throw new Error('extractTrace: unauthorized file path');
  const r = await callWorker<{ ok: boolean; error?: string } & Record<string, any>>({ type: 'extractTrace', path: filePath, index });
  if (!r.ok) throw new Error(r.error || 'extract trace failed');
  return { name: r.name, index: r.index, traceCount: r.traceCount, nSamples: r.nSamples, sampleInt: r.sampleInt, hdr: r.hdr, samples: r.samples };
});

ipcMain.handle('seisconv:getSection', async (_e, opts: Record<string, unknown>) => {
  const r = await callWorker<{ ok: boolean; error?: string } & Record<string, any>>({ type: 'section', ...(opts || {}) });
  if (!r.ok) throw new Error(r.error || 'section failed');
  return {
    numTraces: r.numTraces, colLen: r.colLen, norm: r.norm, sampleInt: r.sampleInt, traceStep: r.traceStep, data: r.data,
    traceStart: r.traceStart, traceEnd: r.traceEnd, sampStart: r.sampStart, sampEnd: r.sampEnd, fullTraces: r.fullTraces, fullSamples: r.fullSamples,
  };
});

// Pick a folder and enumerate its seismic files (by extension), sorted by name.
ipcMain.handle('seisconv:pickInputFolder', async () => {
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths.length) return null;
  const dir = res.filePaths[0];
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && INPUT_EXTS.has(path.extname(e.name).toLowerCase()))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!files.length) return null;
  // Authorize each enumerated file so batchConvert/extractTrace can read them.
  for (const f of files) authorizePath(f.path);
  return { dir, files };
});

// Pick an output folder; returns the chosen path or null.
ipcMain.handle('seisconv:pickOutputFolder', async () => {
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths.length) return null;
  // Authorize the chosen directory so batchConvert may write into it.
  return authorizeDir(res.filePaths[0]);
});

// Strip characters illegal in file names so a templated base is always safe.
function sanitizeBaseName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || 'output';
}

// Apply the output-name template for one file → a safe base name (no extension).
// Tokens: {name} input base, {fmt} writer id, {date} stamp, {n} 1-based index.
function applyNameTemplate(
  tpl: string,
  vars: { name: string; fmt: string; date: string; n?: number },
): string {
  const out = (tpl || '{name}')
    .replace(/\{name\}/g, vars.name)
    .replace(/\{fmt\}/g, vars.fmt)
    .replace(/\{date\}/g, vars.date)
    .replace(/\{n\}/g, vars.n != null ? String(vars.n) : '');
  return sanitizeBaseName(out);
}

// Convert the CURRENTLY-OPEN file to `format` and save via a native dialog. The
// renderer passes the templated `outBaseName` (no extension) as the default name.
ipcMain.handle('seisconv:convertSingle', async (_e, format: string, outBaseName?: string) => {
  const r = await callWorker<{ ok: boolean; bytes?: ArrayBuffer; ext?: string; error?: string }>({ type: 'convert', format });
  if (!r.ok || !r.bytes) return { ok: false, error: r.error ?? 'conversion failed' };
  if (!win) return { ok: false, error: 'no window' };
  const fallback = lastOpenedPath ? path.basename(lastOpenedPath).replace(/\.[^.]+$/, '') : 'output';
  const base = outBaseName && outBaseName.trim() ? sanitizeBaseName(outBaseName) : fallback;
  const save = await dialog.showSaveDialog(win, { defaultPath: `${base}.${r.ext}`, filters: SEISMIC_FILTERS });
  if (save.canceled || !save.filePath) return { ok: false, canceled: true };
  await writeFile(save.filePath, Buffer.from(r.bytes));
  return { ok: true, path: save.filePath };
});

// Trace Workbench EXPORT: write the collected traces out as a seismic file in
// `format`. The worker assembles a synthetic ParsedFile from the passed traces +
// sample interval and runs the writer; we save the returned bytes via the SAME
// native dialog flow as convertSingle. `baseName` (no extension) seeds the
// dialog's default file name.
ipcMain.handle(
  'seisconv:convertTraces',
  async (
    _e,
    args: { traces: { samples: Float32Array; nSamples: number; sampleInt?: number }[]; sampleInt?: number; format: string; baseName?: string },
  ) => {
    const r = await callWorker<{ ok: boolean; bytes?: ArrayBuffer; ext?: string; error?: string }>({
      type: 'convertTraces',
      format: args.format,
      sampleInt: args.sampleInt,
      traces: args.traces,
    });
    if (!r.ok || !r.bytes) return { ok: false, error: r.error ?? 'conversion failed' };
    if (!win) return { ok: false, error: 'no window' };
    const base = args.baseName && args.baseName.trim() ? sanitizeBaseName(args.baseName) : 'workbench';
    const save = await dialog.showSaveDialog(win, { defaultPath: `${base}.${r.ext}`, filters: SEISMIC_FILTERS });
    if (save.canceled || !save.filePath) return { ok: false, canceled: true };
    await writeFile(save.filePath, Buffer.from(r.bytes));
    return { ok: true, path: save.filePath };
  },
);

// Convert a list of files to `format`, writing each into outDir under a name
// derived from the output-name template ({name}/{fmt}/{date}/{n}) + writer ext.
// Emits a per-file progress event; honors cancel between files.
ipcMain.handle(
  'seisconv:batchConvert',
  async (
    _e,
    opts: { files: { name: string; path: string }[]; format: string; outDir: string; nameTemplate?: string; dateStr?: string },
  ) => {
    const files = opts?.files ?? [];
    const tpl = opts?.nameTemplate || '{name}';
    const dateStr = opts?.dateStr || '';
    // The renderer supplies the input paths AND the output directory; neither is
    // trustworthy if the renderer is compromised. Only read inputs the user has
    // actually authorized (dialog/enumerated, same gate as extractTrace), and
    // only write into an output directory the user picked via pickOutputFolder.
    // Without these gates a compromised renderer could read any file on disk and
    // overwrite attacker-controlled bytes into any writable directory.
    if (!isAuthorizedDir(opts.outDir)) {
      return { ok: false, error: 'batchConvert: unauthorized output directory' };
    }
    const outDir = path.resolve(opts.outDir);
    const total = files.length;
    const results: { name: string; ok: boolean; error?: string }[] = [];
    let done = 0;
    let failed = 0;
    let canceled = false;
    cancelRequested = false;

    const emit = (payload: { index: number; total: number; file: string; state: 'start' | 'done' | 'error' | 'cancelled' | 'finished'; error?: string }) => {
      win?.webContents.send('seisconv:convertProgress', payload);
    };

    for (let i = 0; i < total; i++) {
      const f = files[i];
      const index = i + 1;
      if (cancelRequested) {
        canceled = true;
        emit({ index, total, file: f.name, state: 'cancelled' });
        break;
      }
      emit({ index, total, file: f.name, state: 'start' });
      try {
        // Only convert inputs the user actually authorized (dialog/enumerated),
        // mirroring extractTrace — the worker reads f.path with no gate of its own.
        if (!isAuthorizedPath(f.path)) throw new Error('unauthorized input file path');
        const r = await callWorker<{ ok: boolean; bytes?: ArrayBuffer; ext?: string; error?: string }>({ type: 'convertPath', path: f.path, format: opts.format });
        if (!r.ok || !r.bytes) throw new Error(r.error ?? 'conversion failed');
        const inputBase = f.name.replace(/\.[^.]+$/, '');
        const base = applyNameTemplate(tpl, { name: inputBase, fmt: opts.format, date: dateStr, n: index });
        await writeFile(path.join(outDir, `${base}.${r.ext}`), Buffer.from(r.bytes));
        done++;
        results.push({ name: f.name, ok: true });
        emit({ index, total, file: f.name, state: 'done' });
      } catch (e) {
        failed++;
        const error = (e as Error).message;
        results.push({ name: f.name, ok: false, error });
        emit({ index, total, file: f.name, state: 'error', error });
      }
    }

    emit({ index: total, total, file: '', state: 'finished' });
    return { ok: failed === 0 && !canceled, total, done, failed, canceled, results };
  },
);

// Clear the open file + cached state in the worker.
ipcMain.handle('seisconv:resetState', async () => {
  await callWorker({ type: 'reset' });
  lastOpenedPath = '';
  siblingPaths = [];
  siblingIndex = -1;
  // Scope the read/write allowlists to the current working set: resetState drops
  // the open file + siblings, so the paths the user touched before should no
  // longer be reachable by a (possibly compromised) renderer. Without this the
  // sets grow unbounded for the whole process lifetime and keep granting access
  // to every path the user ever opened.
  authorizedPaths.clear();
  authorizedDirs.clear();
});

ipcMain.handle('seisconv:openSPS', async () => {
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'SPS files', extensions: ['s', 'r', 'x', 's01', 'r01', 'x01', 'sps', 'txt'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const r = await callWorker<{ ok: boolean; summary?: any; error?: string }>({ type: 'openSPS', paths: res.filePaths });
  if (!r.ok) throw new Error(r.error || 'SPS parse failed');
  return r.summary;
});

// Clear ONLY the loaded SPS survey in the worker (currentSPS + currentSPSFiles),
// leaving any open seismic file intact. Distinct from resetState, which also
// drops the open file; this backs the SPS tab's dedicated "Clear SPS" button.
ipcMain.handle('seisconv:spsClear', async () => {
  await callWorker({ type: 'spsClear' });
});

ipcMain.handle('seisconv:spsGeometry', async (_e, geo: boolean) => {
  const r = await callWorker<{ ok: boolean; error?: string } & Record<string, any>>({ type: 'spsGeometry', geo });
  if (!r.ok) throw new Error(r.error || 'sps geometry failed');
  return { geo: r.geo, src: r.src, rcv: r.rcv, bbox: r.bbox };
});

// X-ref "spider": shot → live-receiver connection segments as parallel typed
// arrays (sx/sy/rx/ry) + a per-shot group id (shot) and shotKeys mapping.
ipcMain.handle('seisconv:spsXrefLines', async (_e, geo: boolean) => {
  const r = await callWorker<{ ok: boolean; error?: string } & Record<string, any>>({ type: 'spsXrefLines', geo });
  if (!r.ok) throw new Error(r.error || 'sps xref lines failed');
  return { geo: r.geo, sx: r.sx, sy: r.sy, rx: r.rx, ry: r.ry, shot: r.shot, shotKeys: r.shotKeys, decimated: r.decimated, log: r.log };
});

// FOLD / coverage bin map: CMP-midpoint counts per bin, as a row-major Int32
// grid (nx × ny) anchored at (originX, originY) in projected E/N.
ipcMain.handle('seisconv:spsFold', async (_e, opts: { binX: number; binY: number }) => {
  const r = await callWorker<{ ok: boolean; error?: string } & Record<string, any>>({ type: 'spsFold', binX: opts?.binX, binY: opts?.binY });
  if (!r.ok) throw new Error(r.error || 'sps fold failed');
  return { nx: r.nx, ny: r.ny, binX: r.binX, binY: r.binY, originX: r.originX, originY: r.originY, fold: r.fold, maxFold: r.maxFold, totalMid: r.totalMid, decimated: r.decimated, log: r.log };
});

ipcMain.handle('seisconv:spsQC', async (_e, qc: Record<string, number>) => {
  const r = await callWorker<{ ok: boolean; results?: unknown[]; error?: string }>({ type: 'spsQC', qc });
  if (!r.ok) throw new Error(r.error || 'QC failed');
  return r.results;
});

// Fetch the FULL field set of one source/receiver point (the worker owns the
// parsed SPSData; the renderer only holds bare position arrays). Returns null
// when no SPS is loaded or the point can't be matched.
ipcMain.handle('seisconv:spsPointDetail', async (_e, args: { rtype: 'S' | 'R'; lineName: string; point: number; idx?: string }) => {
  const r = await callWorker<{ ok: boolean; detail?: Record<string, unknown> | null; error?: string }>({ type: 'spsPointDetail', ...(args || {}) });
  if (!r.ok) throw new Error(r.error || 'point detail failed');
  return r.detail ?? null;
});

ipcMain.handle('seisconv:spsReproject', async (_e, code: string) => {
  const r = await callWorker<{ ok: boolean; files?: { name: string; text: string }[]; error?: string }>({ type: 'spsReproject', code });
  if (!r.ok || !r.files) return { ok: false, error: r.error ?? 'reprojection failed' };
  if (!win) return { ok: false, error: 'no window' };
  const zip = new JSZip();
  for (const f of r.files) zip.file(f.name, f.text);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const tag = code.replace(':', '');
  const save = await dialog.showSaveDialog(win, { defaultPath: `reprojected_${tag}.zip`, filters: [{ name: 'ZIP archive', extensions: ['zip'] }] });
  if (save.canceled || !save.filePath) return { ok: false, canceled: true };
  await writeFile(save.filePath, buf);
  return { ok: true, path: save.filePath };
});

// SPS HEADER VIEWER: return the shared H block (code/val/raw/desc), the parsed
// projection, the loaded-file list, and whether the files' H blocks differ.
ipcMain.handle('seisconv:spsHeaderList', async () => {
  const r = await callWorker<{ ok: boolean; error?: string } & Record<string, any>>({ type: 'spsHeaderList' });
  if (!r.ok) throw new Error(r.error || 'sps header list failed');
  return { ok: true, headers: r.headers ?? [], projection: r.projection ?? null, files: r.files ?? [], filesDiffer: !!r.filesDiffer };
});

// SPS HEADER EDITOR: apply an edit/add/remove batch (+ optional CRS rewrite) to
// the loaded survey's H block(s), re-parse in the worker, and return the
// refreshed header list. Does NOT save to disk — that's spsSaveCorrected.
ipcMain.handle(
  'seisconv:spsApplyHeaders',
  async (
    _e,
    req: {
      scope: 'shared' | string;
      edits: { code: string; val: string; oldVal?: string }[];
      adds: { code: string; desc?: string; val: string }[];
      removes: (string | { code: string; oldVal?: string })[];
      crs?: Record<string, unknown>;
    },
  ) => {
    const r = await callWorker<{ ok: boolean; headers?: unknown[]; error?: string }>({
      type: 'spsApplyHeaders',
      scope: req?.scope ?? 'shared',
      edits: req?.edits ?? [],
      adds: req?.adds ?? [],
      removes: req?.removes ?? [],
      crs: req?.crs,
    });
    if (!r.ok) return { ok: false, headers: [], error: r.error ?? 'apply headers failed' };
    return { ok: true, headers: r.headers ?? [] };
  },
);

// SPS HEADER EDITOR — save: ZIP the edited currentSPSFiles and write via a native
// dialog. Reuses the spsReproject ZIP save flow (JSZip + showSaveDialog + writeFile).
ipcMain.handle('seisconv:spsSaveCorrected', async () => {
  const r = await callWorker<{ ok: boolean; files?: { name: string; text: string }[]; error?: string }>({ type: 'spsSaveCorrected' });
  if (!r.ok || !r.files) return { ok: false, error: r.error ?? 'save failed' };
  if (!win) return { ok: false, error: 'no window' };
  const zip = new JSZip();
  for (const f of r.files) zip.file(f.name, f.text);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const save = await dialog.showSaveDialog(win, { defaultPath: 'sps_corrected.zip', filters: [{ name: 'ZIP archive', extensions: ['zip'] }] });
  if (save.canceled || !save.filePath) return { ok: false, canceled: true };
  await writeFile(save.filePath, buf);
  return { ok: true, path: save.filePath };
});

// SPS geographic / tabular exports (KML, GeoJSON, CSV trio, QC-report CSV). The
// worker returns one-or-more {name,text} files; we save them with the SAME flow
// as spsReproject: multi-file output is zipped (JSZip), single-file output uses a
// plain native save dialog. The CSV kind yields three files → ZIP; kml / geojson /
// qcreport each yield one file → single-file Save dialog.
ipcMain.handle('seisconv:spsExport', async (_e, args: { kind: 'kml' | 'geojson' | 'csv' | 'qcreport'; qcParams?: Record<string, number> }) => {
  const r = await callWorker<{ ok: boolean; files?: { name: string; text: string }[]; error?: string }>({ type: 'spsExport', kind: args?.kind, qcParams: args?.qcParams });
  if (!r.ok || !r.files) return { ok: false, error: r.error ?? 'export failed' };
  if (!win) return { ok: false, error: 'no window' };

  if (r.files.length > 1) {
    // Same packaging path as the reproject ZIP export.
    const zip = new JSZip();
    for (const f of r.files) zip.file(f.name, f.text);
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const save = await dialog.showSaveDialog(win, { defaultPath: `sps_${args.kind}.zip`, filters: [{ name: 'ZIP archive', extensions: ['zip'] }] });
    if (save.canceled || !save.filePath) return { ok: false, canceled: true };
    await writeFile(save.filePath, buf);
    return { ok: true, path: save.filePath };
  }

  // Single-file: same single-file Save flow as exportText.
  const f = r.files[0];
  const save = await dialog.showSaveDialog(win, { defaultPath: f.name });
  if (save.canceled || !save.filePath) return { ok: false, canceled: true };
  await writeFile(save.filePath, f.text, 'utf8');
  return { ok: true, path: save.filePath };
});

ipcMain.handle('seisconv:semblance', async (_e, opts: { velMin: number; velMax: number; velStep: number }) => {
  const r = await callWorker<{ ok: boolean; error?: string } & Record<string, any>>({ type: 'semblance', ...opts });
  if (!r.ok) throw new Error(r.error || 'semblance failed');
  return { semb: r.semb, vels: r.vels, nT: r.nT, dt: r.dt, siUs: r.siUs, offNote: r.offNote };
});

// Spectrum Analysis tab: average amplitude spectrum, single-trace spectrogram
// (STFT), and the section's f-k spectrum. Each forwards the open file's typed
// arrays straight through from the worker (transferred, zero-copy).
ipcMain.handle('seisconv:avgSpectrum', async (_e, opts: { traceStart?: number; traceEnd?: number }) => {
  const r = await callWorker<{ ok: boolean; error?: string } & Record<string, any>>({ type: 'avgSpectrum', ...(opts || {}) });
  if (!r.ok) throw new Error(r.error || 'avgSpectrum failed');
  return { freqs: r.freqs, amp: r.amp, nyquist: r.nyquist, nTraces: r.nTraces, decimated: r.decimated, log: r.log };
});

ipcMain.handle('seisconv:spectrogram', async (_e, opts: { index: number; winLen?: number; hop?: number }) => {
  const r = await callWorker<{ ok: boolean; error?: string } & Record<string, any>>({ type: 'spectrogram', ...(opts || {}) });
  if (!r.ok) throw new Error(r.error || 'spectrogram failed');
  return { mag: r.mag, nFrames: r.nFrames, nBins: r.nBins, freqs: r.freqs, times: r.times, maxMag: r.maxMag, siUs: r.siUs };
});

ipcMain.handle('seisconv:fk', async (_e, opts: { dx?: number }) => {
  const r = await callWorker<{ ok: boolean; error?: string } & Record<string, any>>({ type: 'fk', ...(opts || {}) });
  if (!r.ok) throw new Error(r.error || 'fk failed');
  return { mag: r.mag, nKx: r.nKx, nF: r.nF, kAxis: r.kAxis, fAxis: r.fAxis, maxMag: r.maxMag, decimated: r.decimated, log: r.log };
});

ipcMain.handle('seisconv:exportText', async (_e, args: { name: string; text: string }) => {
  if (!win) return { ok: false };
  const save = await dialog.showSaveDialog(win, { defaultPath: args.name });
  if (save.canceled || !save.filePath) return { ok: false, canceled: true };
  await writeFile(save.filePath, args.text, 'utf8');
  return { ok: true, path: save.filePath };
});

// Save arbitrary BINARY bytes (e.g. an .xlsx / .ods the renderer built in-core)
// via a native dialog. Mirrors exportText but writes a Buffer instead of a UTF-8
// string. `bytes` arrives as a Uint8Array over IPC (structured-clone safe).
ipcMain.handle('seisconv:exportBinary', async (_e, args: { name: string; bytes: Uint8Array }) => {
  if (!win) return { ok: false };
  const save = await dialog.showSaveDialog(win, { defaultPath: args.name });
  if (save.canceled || !save.filePath) return { ok: false, canceled: true };
  await writeFile(save.filePath, Buffer.from(args.bytes));
  return { ok: true, path: save.filePath };
});

// Read a user-picked JSON file with a size bound, so a pathologically large file
// can't be slurped + JSON.parse'd + materialized into renderer state unbounded.
// Observer-log / template JSON is at most a few MB in practice; 64 MB is generous.
const MAX_JSON_BYTES = 64 * 1024 * 1024;
async function readJsonFileBounded(path: string): Promise<unknown> {
  const st = await stat(path);
  if (st.size > MAX_JSON_BYTES) {
    throw new Error(`file too large (${st.size} bytes > ${MAX_JSON_BYTES} cap)`);
  }
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

// Observer Log RELOAD: open a .json picker, read + parse it, and return the
// {meta, columns, rows} payload (or null if cancelled / unreadable). The shape
// matches what the renderer saves via exportText('observer-log.json', …).
ipcMain.handle('seisconv:openLogJson', async () => {
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'Observer Log (JSON)', extensions: ['json'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const o = (await readJsonFileBounded(res.filePaths[0])) as { meta?: unknown; columns?: unknown; rows?: unknown };
  return {
    meta: o && typeof o.meta === 'object' && o.meta ? o.meta : {},
    columns: Array.isArray(o?.columns) ? o.columns : [],
    rows: Array.isArray(o?.rows) ? o.rows : [],
  };
});

// Observer Log TEMPLATE import: open a .json picker, read + parse it, and return
// the RAW parsed object (or null if cancelled / unreadable). Unlike openLogJson
// (which narrows to {meta,columns,rows}), templates carry {meta,columns,srcType,
// timeSource}, so we hand the renderer the whole object to validate itself.
ipcMain.handle('seisconv:openTemplateJson', async () => {
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'Observer Log template (JSON)', extensions: ['json'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return readJsonFileBounded(res.filePaths[0]);
});

// Observer Log "Sync clock": query an SNTP server over UDP and return the offset
// (serverTimeMs - local Date.now()). Never throws — a failed/offline query
// resolves { ok: false, error }. Default server 'pool.ntp.org'.
ipcMain.handle('seisconv:ntpSync', async (_e, server?: string) => {
  const host = (typeof server === 'string' && server.trim()) ? server.trim() : 'pool.ntp.org';
  if (isInternalNtpHost(host)) return { ok: false, error: 'NTP server must be a public host (internal/loopback addresses are blocked)' };
  return sntpQuery(host);
});

// Observer Log SPS-linking: flat list of the loaded survey's source records, for
// columns the user links to an SPS source field. Forwards to the worker (which
// owns the parsed SPSData); returns { sources: [] } when no survey is loaded.
ipcMain.handle('seisconv:spsSourceList', async () => {
  const r = await callWorker<{ ok: boolean; sources?: unknown[]; error?: string }>({ type: 'spsSourceList' });
  if (!r.ok) throw new Error(r.error || 'sps source list failed');
  return { sources: r.sources ?? [] };
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
