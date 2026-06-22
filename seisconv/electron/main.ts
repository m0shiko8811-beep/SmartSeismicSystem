// SeisConv — Electron main process.
//
// Owns the window + native dialogs and drives ONE long-lived worker thread that
// holds the parsed file and answers view/convert requests. The renderer is
// sandboxed (contextIsolation, no nodeIntegration); it reaches privileged work
// only through the typed `seisconvAPI` in preload.

import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { writeFile, readdir } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import JSZip from 'jszip';

const WORKER_PATH = path.join(__dirname, 'parse.worker.js');

// Native title-bar overlay height (DIPs). MUST equal the app-shell header row
// (renderer grid-template-rows:54px) so the min/max/close controls sit exactly
// inside the header. Single source of truth: every setTitleBarOverlay() call
// forces it, because Electron RESETS the overlay height to the system default
// whenever a setTitleBarOverlay() call OMITS `height` — that reset (triggered by
// the renderer's per-theme recolor) is what detached the controls in packaged builds.
const TITLEBAR_HEIGHT = 54;

const SEISMIC_FILTERS = [
  { name: 'Seismic files', extensions: ['segy', 'sgy', 'segd', 'seg', 'su', 'seg2', 'dat', 'bat'] },
  { name: 'All files', extensions: ['*'] },
];

// Input-folder enumeration: extensions (lower-case, no dot) we treat as seismic.
const INPUT_EXTS = new Set(['.segy', '.sgy', '.segd', '.seg', '.seg2', '.dat', '.bat', '.su']);

let win: BrowserWindow | null = null;
let lastOpenedPath = '';

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

function createWindow(): void {
  win = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#0d1f33',
    show: false,
    // Frameless: drop the native OS title bar so the app's own header is the
    // top of the window, but keep functional native min/max/close as a Windows
    // Controls Overlay we recolor per theme (see seisconv:setTitleBarOverlay).
    // Defaults match the LIGHT-theme header (--header-bg over --canvas) so the
    // first paint is correct before the renderer's initTheme() runs.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#f3f6fb',     // light header background (opaque equivalent)
      symbolColor: '#15212f', // --ink (dark/navy glyphs)
      height: TITLEBAR_HEIGHT, // matches the app-shell header row (renderer grid 54px)
    },
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
  void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

// ── IPC ──
ipcMain.handle('seisconv:openAndParse', async () => {
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: SEISMIC_FILTERS });
  if (res.canceled || !res.filePaths.length) return null;
  const filePath = res.filePaths[0];
  const r = await callWorker<{ ok: boolean; summary?: any; error?: string }>({ type: 'open', path: filePath });
  if (!r.ok) throw new Error(r.error || 'parse failed');
  lastOpenedPath = filePath;
  return { path: filePath, name: path.basename(filePath), ...r.summary };
});

ipcMain.handle('seisconv:getTrace', async (_e, index: number) => {
  const r = await callWorker<{ ok: boolean; error?: string } & Record<string, any>>({ type: 'trace', index });
  if (!r.ok) throw new Error(r.error || 'trace failed');
  return { index: r.index, nSamples: r.nSamples, sampleInt: r.sampleInt, hdr: r.hdr, samples: r.samples };
});

ipcMain.handle('seisconv:getSection', async (_e, opts: Record<string, unknown>) => {
  const r = await callWorker<{ ok: boolean; error?: string } & Record<string, any>>({ type: 'section', ...(opts || {}) });
  if (!r.ok) throw new Error(r.error || 'section failed');
  return { numTraces: r.numTraces, colLen: r.colLen, norm: r.norm, sampleInt: r.sampleInt, traceStep: r.traceStep, data: r.data };
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
  return { dir, files };
});

// Pick an output folder; returns the chosen path or null.
ipcMain.handle('seisconv:pickOutputFolder', async () => {
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
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
        const r = await callWorker<{ ok: boolean; bytes?: ArrayBuffer; ext?: string; error?: string }>({ type: 'convertPath', path: f.path, format: opts.format });
        if (!r.ok || !r.bytes) throw new Error(r.error ?? 'conversion failed');
        const inputBase = f.name.replace(/\.[^.]+$/, '');
        const base = applyNameTemplate(tpl, { name: inputBase, fmt: opts.format, date: dateStr, n: index });
        await writeFile(path.join(opts.outDir, `${base}.${r.ext}`), Buffer.from(r.bytes));
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
});

// Recolor the native window-controls overlay (min/max/close) so it always
// matches the app header — called by the renderer's applyTheme() per theme.
ipcMain.handle('seisconv:setTitleBarOverlay', (_e, opts: { color: string; symbolColor: string }) => {
  // Force the height on every call: Electron resets it to the system default when
  // omitted, which detaches the controls from the 54px header row (the packaged bug).
  win?.setTitleBarOverlay({ ...opts, height: TITLEBAR_HEIGHT });
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

ipcMain.handle('seisconv:spsGeometry', async (_e, geo: boolean) => {
  const r = await callWorker<{ ok: boolean; error?: string } & Record<string, any>>({ type: 'spsGeometry', geo });
  if (!r.ok) throw new Error(r.error || 'sps geometry failed');
  return { geo: r.geo, src: r.src, rcv: r.rcv, bbox: r.bbox };
});

ipcMain.handle('seisconv:spsQC', async (_e, qc: Record<string, number>) => {
  const r = await callWorker<{ ok: boolean; results?: unknown[]; error?: string }>({ type: 'spsQC', qc });
  if (!r.ok) throw new Error(r.error || 'QC failed');
  return r.results;
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

ipcMain.handle('seisconv:semblance', async (_e, opts: { velMin: number; velMax: number; velStep: number }) => {
  const r = await callWorker<{ ok: boolean; error?: string } & Record<string, any>>({ type: 'semblance', ...opts });
  if (!r.ok) throw new Error(r.error || 'semblance failed');
  return { semb: r.semb, vels: r.vels, nT: r.nT, dt: r.dt, siUs: r.siUs, offNote: r.offNote };
});

ipcMain.handle('seisconv:exportText', async (_e, args: { name: string; text: string }) => {
  if (!win) return { ok: false };
  const save = await dialog.showSaveDialog(win, { defaultPath: args.name });
  if (save.canceled || !save.filePath) return { ok: false, canceled: true };
  await writeFile(save.filePath, args.text, 'utf8');
  return { ok: true, path: save.filePath };
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
