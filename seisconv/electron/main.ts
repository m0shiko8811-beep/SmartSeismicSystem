// SeisConv — Electron main process.
//
// Owns the window + native dialogs, and delegates all heavy work (parse/convert)
// to a worker thread running the pure-TS core, so the UI never blocks on large
// files. The renderer is sandboxed (contextIsolation, no nodeIntegration); it can
// only reach privileged APIs through the typed `seisconvAPI` exposed in preload.

import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { writeFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import * as path from 'node:path';

const WORKER_PATH = path.join(__dirname, 'parse.worker.js');

const SEISMIC_FILTERS = [
  { name: 'Seismic files', extensions: ['segy', 'sgy', 'segd', 'seg', 'su', 'seg2', 'dat', 'bat'] },
  { name: 'All files', extensions: ['*'] },
];

let win: BrowserWindow | null = null;

/** Run one task on a fresh worker thread and resolve with its single reply. */
function runWorker<T = any>(task: unknown, transfer: Transferable[] = []): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH);
    worker.once('message', (msg: T) => {
      resolve(msg);
      void worker.terminate();
    });
    worker.once('error', (err) => {
      reject(err);
      void worker.terminate();
    });
    worker.postMessage(task, transfer as any);
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 720,
    minHeight: 540,
    backgroundColor: '#0d0f14',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win?.show());
  void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

// ── IPC: open a file and parse it (in the worker) → summary ──
ipcMain.handle('seisconv:openAndParse', async () => {
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: SEISMIC_FILTERS });
  if (res.canceled || !res.filePaths.length) return null;
  const filePath = res.filePaths[0];
  const summary = await runWorker<Record<string, unknown>>({ type: 'parse', path: filePath });
  return { path: filePath, name: path.basename(filePath), ...summary };
});

// ── IPC: convert a file (in the worker) → native Save dialog → write to disk ──
ipcMain.handle('seisconv:convert', async (_e, args: { path: string; format: string }) => {
  const res = await runWorker<{ ok: boolean; bytes?: ArrayBuffer; suggestedName?: string; error?: string }>({
    type: 'convert',
    path: args.path,
    format: args.format,
  });
  if (!res.ok || !res.bytes) return { ok: false, error: res.error ?? 'conversion failed' };
  if (!win) return { ok: false, error: 'no window' };
  const save = await dialog.showSaveDialog(win, { defaultPath: res.suggestedName, filters: SEISMIC_FILTERS });
  if (save.canceled || !save.filePath) return { ok: false, canceled: true };
  await writeFile(save.filePath, Buffer.from(res.bytes));
  return { ok: true, path: save.filePath };
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'fileMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
