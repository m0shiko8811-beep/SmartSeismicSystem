// SeisConv — preload bridge.
//
// The ONLY channel between the sandboxed renderer and Node/Electron. Exposes a
// tiny, typed `window.seisconvAPI`; everything privileged (fs, dialogs, the
// worker) stays in the main process behind these IPC calls.

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

export interface TraceData {
  index: number;
  nSamples: number;
  sampleInt: number;
  hdr: Record<string, number | string>;
  samples: Float32Array;
}

export interface SectionOpts {
  maxTraces?: number;
  maxSamples?: number;
  agc?: boolean;
  agcType?: 'rms' | 'median' | 'mean';
  agcWindowMs?: number;
}

export interface SectionData {
  numTraces: number;
  colLen: number;
  norm: number;
  sampleInt: number;
  traceStep: number;
  data: Float32Array; // numTraces × colLen, row-major (row = trace)
}

export interface ConvertResult {
  ok: boolean;
  path?: string;
  canceled?: boolean;
  error?: string;
}

export interface InputFolder {
  dir: string;
  files: { name: string; path: string }[];
}

export interface BatchOpts {
  files: { name: string; path: string }[];
  format: string;
  outDir: string;
  /** Output-name template ({name}/{fmt}/{date}/{n}); defaults to `{name}` on the main side. */
  nameTemplate?: string;
  /** Date stamp (YYYYMMDD) substituted for the {date} token. */
  dateStr?: string;
}

export interface BatchResult {
  ok: boolean;
  total: number;
  done: number;
  failed: number;
  canceled: boolean;
  results: { name: string; ok: boolean; error?: string }[];
}

export interface ConvertProgress {
  index: number;
  total: number;
  file: string;
  state: 'start' | 'done' | 'error' | 'cancelled' | 'finished';
  error?: string;
}

export interface SPSSummary {
  sources: number;
  receivers: number;
  xrefs: number;
  layout: string | null;
  projection: { type: string | null; subtype: string | null; desc?: string; latOrigin?: number | null; zone?: number | null } | null;
  errors: string[];
}

export interface SpsLines {
  x: Float32Array;
  y: Float32Array;
  line: Int32Array;
  pt: Float32Array;
  names: string[];
}

export interface SpsGeometry {
  geo: boolean;
  src: SpsLines;
  rcv: SpsLines;
  bbox: { minX: number; maxX: number; minY: number; maxY: number };
}

export interface QCRow {
  sev: string;
  cat: string;
  msg: string;
}

export interface SemblanceData {
  semb: Float32Array;
  vels: number[];
  nT: number;
  dt: number;
  siUs: number;
  offNote: string;
}

const api = {
  /** Host OS, for OS-aware key hints (set to process.platform at preload load). */
  platform: process.platform as string,
  /** Open a file picker, parse the chosen file off-thread; returns a summary (or null if cancelled). */
  openAndParse: (): Promise<ParseSummary | null> => ipcRenderer.invoke('seisconv:openAndParse'),
  /** Get one trace's samples + header from the currently-open file. */
  getTrace: (index: number): Promise<TraceData> => ipcRenderer.invoke('seisconv:getTrace', index),
  /** Get a decimated section matrix (for variable-density / wiggle display). */
  getSection: (opts?: SectionOpts): Promise<SectionData> => ipcRenderer.invoke('seisconv:getSection', opts ?? {}),
  /** Pick an input folder; returns its seismic files (sorted by name) or null. */
  pickInputFolder: (): Promise<InputFolder | null> => ipcRenderer.invoke('seisconv:pickInputFolder'),
  /** Pick an output folder; returns the chosen path or null. */
  pickOutputFolder: (): Promise<string | null> => ipcRenderer.invoke('seisconv:pickOutputFolder'),
  /** Convert the currently-open file to `format` and save via a native dialog;
   *  `outBaseName` (no extension) becomes the save dialog's default file name. */
  convertSingle: (format: string, outBaseName?: string): Promise<ConvertResult> =>
    ipcRenderer.invoke('seisconv:convertSingle', format, outBaseName),
  /** Convert a list of files to `format`, writing each into outDir; emits progress per file. */
  batchConvert: (opts: BatchOpts): Promise<BatchResult> => ipcRenderer.invoke('seisconv:batchConvert', opts),
  /** Subscribe to batch-convert progress; returns an unsubscribe fn. */
  onConvertProgress: (cb: (p: ConvertProgress) => void): (() => void) => {
    const listener = (_e: unknown, p: ConvertProgress) => cb(p);
    ipcRenderer.on('seisconv:convertProgress', listener);
    return () => ipcRenderer.removeListener('seisconv:convertProgress', listener);
  },
  /** Signal the running batch to stop. */
  cancelConvert: (): void => ipcRenderer.send('seisconv:cancelConvert'),
  /** Clear the open file + cached state in the worker. */
  resetState: (): Promise<void> => ipcRenderer.invoke('seisconv:resetState'),
  /** Open one or more SPS files (S/R/X), parse + merge them, return a summary. */
  openSPS: (): Promise<SPSSummary | null> => ipcRenderer.invoke('seisconv:openSPS'),
  /** Get line-grouped survey geometry (projected E/N, or WGS84 lon/lat when geo=true). */
  spsGeometry: (geo: boolean): Promise<SpsGeometry> => ipcRenderer.invoke('seisconv:spsGeometry', geo),
  /** Run survey QC on the loaded SPS data. */
  spsQC: (qc?: { srcInt?: number; rcvInt?: number; tol?: number; maxOff?: number; maxSrc?: number; maxRcv?: number }): Promise<QCRow[]> =>
    ipcRenderer.invoke('seisconv:spsQC', qc ?? {}),
  /** Reproject the loaded SPS survey to an EPSG target and save a ZIP. */
  spsReproject: (code: string): Promise<ConvertResult> => ipcRenderer.invoke('seisconv:spsReproject', code),
  /** Compute an NMO semblance panel for the open file. */
  semblance: (opts: { velMin: number; velMax: number; velStep: number }): Promise<SemblanceData> => ipcRenderer.invoke('seisconv:semblance', opts),
  /** Save arbitrary text (e.g. velocity picks CSV) via a native dialog. */
  exportText: (name: string, text: string): Promise<ConvertResult> => ipcRenderer.invoke('seisconv:exportText', { name, text }),
  /** Minimize the window (custom header control). */
  winMinimize: (): void => ipcRenderer.send('seisconv:win-minimize'),
  /** Toggle maximize / restore (custom header control). */
  winMaximizeToggle: (): void => ipcRenderer.send('seisconv:win-maximize-toggle'),
  /** Close the window (custom header control). */
  winClose: (): void => ipcRenderer.send('seisconv:win-close'),
  /** Subscribe to maximize-state changes so the UI can swap the maximize/restore icon; returns an unsubscribe fn. */
  onWinMaximized: (cb: (maximized: boolean) => void): (() => void) => {
    const listener = (_e: unknown, maximized: boolean) => cb(maximized);
    ipcRenderer.on('seisconv:win-maximized', listener);
    return () => ipcRenderer.removeListener('seisconv:win-maximized', listener);
  },
};

export type SeisconvAPI = typeof api;

contextBridge.exposeInMainWorld('seisconvAPI', api);
