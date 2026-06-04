// SeisConv — preload bridge.
//
// The ONLY channel between the sandboxed renderer and Node/Electron. Exposes a
// tiny, typed `window.seisconvAPI`; everything privileged (fs, dialogs, workers)
// stays in the main process behind these IPC calls.

import { contextBridge, ipcRenderer } from 'electron';

export interface ParseSummary {
  path: string;
  name: string;
  format: string;
  revision: number;
  traceCount: number;
  samplesTrace: number | null;
  sampleInt: number | null;
  errors: string[];
}

export interface ConvertResult {
  ok: boolean;
  path?: string;
  canceled?: boolean;
  error?: string;
}

const api = {
  /** Open a file picker, parse the chosen file off-thread, return a summary (or null if cancelled). */
  openAndParse: (): Promise<ParseSummary | null> => ipcRenderer.invoke('seisconv:openAndParse'),
  /** Convert a previously-opened file to `format` ('segy1' | 'segy0' | 'su') and save via a native dialog. */
  convert: (filePath: string, format: string): Promise<ConvertResult> =>
    ipcRenderer.invoke('seisconv:convert', { path: filePath, format }),
};

export type SeisconvAPI = typeof api;

contextBridge.exposeInMainWorld('seisconvAPI', api);
