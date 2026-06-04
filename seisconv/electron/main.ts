// SeisConv — Electron main process.
//
// Owns the window + native dialogs and drives ONE long-lived worker thread that
// holds the parsed file and answers view/convert requests. The renderer is
// sandboxed (contextIsolation, no nodeIntegration); it reaches privileged work
// only through the typed `seisconvAPI` in preload.

import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { writeFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import JSZip from 'jszip';

const WORKER_PATH = path.join(__dirname, 'parse.worker.js');

const SEISMIC_FILTERS = [
  { name: 'Seismic files', extensions: ['segy', 'sgy', 'segd', 'seg', 'su', 'seg2', 'dat', 'bat'] },
  { name: 'All files', extensions: ['*'] },
];

let win: BrowserWindow | null = null;
let lastOpenedPath = '';

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

ipcMain.handle('seisconv:convert', async (_e, args: { format: string }) => {
  const r = await callWorker<{ ok: boolean; bytes?: ArrayBuffer; ext?: string; error?: string }>({ type: 'convert', format: args.format });
  if (!r.ok || !r.bytes) return { ok: false, error: r.error ?? 'conversion failed' };
  if (!win) return { ok: false, error: 'no window' };
  const base = lastOpenedPath ? path.basename(lastOpenedPath).replace(/\.[^.]+$/, '') : 'output';
  const save = await dialog.showSaveDialog(win, { defaultPath: `${base}.${r.ext}`, filters: SEISMIC_FILTERS });
  if (save.canceled || !save.filePath) return { ok: false, canceled: true };
  await writeFile(save.filePath, Buffer.from(r.bytes));
  return { ok: true, path: save.filePath };
});

ipcMain.handle('seisconv:batchConvert', async (_e, format: string) => {
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: SEISMIC_FILTERS });
  if (res.canceled || !res.filePaths.length) return null;
  const r = await callWorker<{ ok: boolean; zip?: ArrayBuffer; results?: unknown[]; error?: string }>({ type: 'batchConvert', paths: res.filePaths, format });
  if (!r.ok || !r.zip) return { ok: false, error: r.error ?? 'batch failed' };
  const save = await dialog.showSaveDialog(win, { defaultPath: `converted_${format}.zip`, filters: [{ name: 'ZIP archive', extensions: ['zip'] }] });
  if (save.canceled || !save.filePath) return { ok: false, canceled: true, results: r.results };
  await writeFile(save.filePath, Buffer.from(r.zip));
  return { ok: true, path: save.filePath, results: r.results };
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

ipcMain.handle('seisconv:getSpsPoints', async () => {
  const r = await callWorker<{ ok: boolean; error?: string } & Record<string, any>>({ type: 'spsPoints' });
  if (!r.ok) throw new Error(r.error || 'sps points failed');
  return { srcE: r.srcE, srcN: r.srcN, rcvE: r.rcvE, rcvN: r.rcvN };
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

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'fileMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
