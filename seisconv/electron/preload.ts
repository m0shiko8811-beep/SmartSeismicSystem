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

export interface SPSSummary {
  sources: number;
  receivers: number;
  xrefs: number;
  layout: string | null;
  projection: { type: string | null; subtype: string | null; desc?: string; latOrigin?: number | null; zone?: number | null } | null;
  errors: string[];
}

export interface SpsPoints {
  srcE: Float32Array;
  srcN: Float32Array;
  rcvE: Float32Array;
  rcvN: Float32Array;
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
  /** Open a file picker, parse the chosen file off-thread; returns a summary (or null if cancelled). */
  openAndParse: (): Promise<ParseSummary | null> => ipcRenderer.invoke('seisconv:openAndParse'),
  /** Get one trace's samples + header from the currently-open file. */
  getTrace: (index: number): Promise<TraceData> => ipcRenderer.invoke('seisconv:getTrace', index),
  /** Get a decimated section matrix (for variable-density / wiggle display). */
  getSection: (opts?: SectionOpts): Promise<SectionData> => ipcRenderer.invoke('seisconv:getSection', opts ?? {}),
  /** Convert the currently-open file to `format` ('segy1' | 'segy0' | 'su') and save via a native dialog. */
  convert: (format: string): Promise<ConvertResult> => ipcRenderer.invoke('seisconv:convert', { format }),
  /** Convert many files to `format` and save them as a single ZIP. */
  batchConvert: (format: string): Promise<(ConvertResult & { results?: { name: string; ok: boolean; traces?: number; error?: string }[] }) | null> =>
    ipcRenderer.invoke('seisconv:batchConvert', format),
  /** Open one or more SPS files (S/R/X), parse + merge them, return a summary. */
  openSPS: (): Promise<SPSSummary | null> => ipcRenderer.invoke('seisconv:openSPS'),
  /** Get source/receiver coordinate arrays for the survey plot. */
  getSpsPoints: (): Promise<SpsPoints> => ipcRenderer.invoke('seisconv:getSpsPoints'),
  /** Run survey QC on the loaded SPS data. */
  spsQC: (qc?: { srcInt?: number; rcvInt?: number; tol?: number; maxOff?: number; maxSrc?: number; maxRcv?: number }): Promise<QCRow[]> =>
    ipcRenderer.invoke('seisconv:spsQC', qc ?? {}),
  /** Reproject the loaded SPS survey to an EPSG target and save a ZIP. */
  spsReproject: (code: string): Promise<ConvertResult> => ipcRenderer.invoke('seisconv:spsReproject', code),
  /** Compute an NMO semblance panel for the open file. */
  semblance: (opts: { velMin: number; velMax: number; velStep: number }): Promise<SemblanceData> => ipcRenderer.invoke('seisconv:semblance', opts),
  /** Save arbitrary text (e.g. velocity picks CSV) via a native dialog. */
  exportText: (name: string, text: string): Promise<ConvertResult> => ipcRenderer.invoke('seisconv:exportText', { name, text }),
};

export type SeisconvAPI = typeof api;

contextBridge.exposeInMainWorld('seisconvAPI', api);
