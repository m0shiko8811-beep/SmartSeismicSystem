// SeisConv — preload bridge.
//
// The ONLY channel between the sandboxed renderer and Node/Electron. Exposes a
// tiny, typed `window.seisconvAPI`; everything privileged (fs, dialogs, the
// worker) stays in the main process behind these IPC calls.

import { contextBridge, ipcRenderer, webFrame } from 'electron';

/** Clamp a zoom factor to the app's allowed UI-zoom range (50 %–250 %). */
function clampZoom(factor: number): number {
  if (!Number.isFinite(factor)) return 1;
  return Math.min(2.5, Math.max(0.5, factor));
}

export interface ParseSummary {
  path: string;
  name: string;
  format: string;
  revision: number;
  traceCount: number;
  samplesTrace: number | null;
  sampleInt: number | null;
  byteOrder: string;
  errors: string[];
  /** 0-based position of this file among its seismic siblings (open file's folder). */
  index: number;
  /** Number of seismic siblings in the open file's folder. */
  count: number;
  /** Whether a previous sibling exists (index > 0). */
  hasPrev: boolean;
  /** Whether a next sibling exists (index < count - 1). */
  hasNext: boolean;
}

export interface TraceData {
  index: number;
  nSamples: number;
  sampleInt: number;
  hdr: Record<string, number | string>;
  samples: Float32Array;
}

/** One trace pulled from an arbitrary file by the Trace Workbench (extractTrace).
 *  Same shape as TraceData plus the source file name + total trace count, so the
 *  workbench can label the entry and clamp the trace-index input. */
export interface ExtractedTrace {
  name: string;
  index: number;
  traceCount: number;
  nSamples: number;
  sampleInt: number;
  hdr: Record<string, number | string>;
  samples: Float32Array;
}

export interface SectionOpts {
  maxTraces?: number;
  maxSamples?: number;
  // Optional visible sub-window in full-data indices (end exclusive). When set,
  // only this trace/sample range is decimated, so zoom re-fetches real detail.
  traceStart?: number;
  traceEnd?: number;
  sampStart?: number;
  sampEnd?: number;
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
  // Window actually returned (full-data indices, end exclusive) + full extents,
  // so the renderer can label the time/trace axes and clamp pan/zoom.
  traceStart: number;
  traceEnd: number;
  sampStart: number;
  sampEnd: number;
  fullTraces: number;
  fullSamples: number;
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
  /** Distinct positioning format label(s) detected this Load (e.g. ['SPS','P1/11']). */
  formats?: string[];
  /** Brief P6/11 bin-grid summary when a grid was loaded this Load (else null). */
  binGrid?: { nInline: number; nCrossline: number; originE: number; originN: number; binI: number; binJ: number; inlineAzimuth: number } | null;
}

/** A P6/11 acquisition bin grid in projected (E/N) space, as returned by `binGrid()`.
 *  Mirrors core/sps/bingrid.ts BinGrid (the QC overlay reads origin/azimuth/corners). */
export interface BinGridInfo {
  name?: string;
  crs?: SPSSummary['projection'] | null;
  originE: number;
  originN: number;
  binI: number;
  binJ: number;
  nInline: number;
  nCrossline: number;
  inlineAzimuth: number;
  firstInline: number;
  firstCrossline: number;
  incInline: number;
  incCrossline: number;
  corners?: { e: number; n: number }[];
  raw: string[];
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

/** Shot → live-receiver connection segments ("spider"). Parallel typed arrays:
 *  segment i runs (sx[i],sy[i]) → (rx[i],ry[i]); shot[i] is its per-shot group id
 *  (index into shotKeys, each 'srcLine|srcPt'). Coords are projected E/N, or
 *  WGS84 lon/lat when geo=true. `decimated` flags a capped/sampled survey. */
export interface SpsXrefLines {
  geo: boolean;
  sx: Float32Array;
  sy: Float32Array;
  rx: Float32Array;
  ry: Float32Array;
  shot: Int32Array;
  shotKeys: string[];
  decimated: boolean;
  log: string;
}

/** FOLD / coverage bin map: CMP-midpoint counts per bin. `fold` is a row-major
 *  Int32 grid of nx×ny cells; cell (ix,iy) lives at fold[iy*nx+ix] and covers the
 *  projected E/N rectangle [originX+ix*binX, originX+(ix+1)*binX] ×
 *  [originY+iy*binY, originY+(iy+1)*binY]. `decimated` flags a sampled survey. */
export interface SpsFold {
  nx: number;
  ny: number;
  binX: number;
  binY: number;
  originX: number;
  originY: number;
  fold: Int32Array;
  maxFold: number;
  totalMid: number;
  decimated: boolean;
  log: string;
}

/** Lightweight coords for one offending point in a QC finding (no full SPSPoint). */
export interface QCPoint {
  rtype: 'S' | 'R';
  lineName: string;
  point: number;
  easting: number;
  northing: number;
}

export interface QCRow {
  sev: string;
  cat: string;
  msg: string;
  /** Offending points for this finding (empty for findings without locations). */
  pts: QCPoint[];
}

/** Full field set for one source/receiver point (source vs receiver extras differ). */
export interface SPSPointDetail {
  rtype: 'S' | 'R';
  lineName: string;
  point: number;
  idx: string;
  easting: number;
  northing: number;
  elevation: number;
  raw: string;
  upholeMs?: number;
  srcType?: string;
  date?: string;
  time?: string;
  ffid?: number;
  staticMs?: number;
}

export interface SemblanceData {
  semb: Float32Array;
  vels: number[];
  nT: number;
  dt: number;
  siUs: number;
  offNote: string;
}

/** Average amplitude spectrum across the open file (or a trace sub-window): the
 *  mean of per-trace single-sided spectra. `freqs`/`amp` are parallel length-N/2
 *  arrays; `nTraces` is how many traces contributed; `decimated` flags a sampled
 *  (strided) trace set. */
export interface AvgSpectrumData {
  freqs: Float32Array;
  amp: Float32Array;
  nyquist: number;
  nTraces: number;
  decimated: boolean;
  log: string;
}

/** STFT spectrogram of one trace: `mag` is a row-major nFrames×nBins Float32 grid
 *  (row = time frame, col = freq bin); `freqs` (Hz, length nBins) + `times` (s,
 *  length nFrames) are the axes; `maxMag` is the peak for normalized display. */
export interface SpectrogramData {
  mag: Float32Array;
  nFrames: number;
  nBins: number;
  freqs: Float32Array;
  times: Float32Array;
  maxMag: number;
  siUs: number;
}

/** f-k (frequency–wavenumber) spectrum of the section: `mag` is a row-major
 *  nF×nKx Float32 grid (row = frequency, col = wavenumber); `fAxis` (Hz, positive
 *  half) + `kAxis` (cycles/distance-unit, fftshifted so kx=0 is centred) are the
 *  axes; `maxMag` is the peak; `decimated` flags a sampled section. */
export interface FkData {
  mag: Float32Array;
  nKx: number;
  nF: number;
  kAxis: Float32Array;
  fAxis: Float32Array;
  maxMag: number;
  decimated: boolean;
  log: string;
}

/** One SPS H-record row for the Header Viewer/Editor: the 4-char code, the
 *  editable DATA value, the original raw line, and a human-readable description. */
export interface SPSHeaderRow {
  code: string;
  val: string;
  raw: string;
  desc: string;
}

/** Parsed projection / datum block surfaced alongside the H-record list. */
export interface SPSHeaderProjection {
  type: string | null;
  subtype: string | null;
  zone: number | null;
  hemi: string | null;
  datum: string | null;
  ellipsoid: string | null;
  units: string;
  centralMeridian: number | null;
  latOrigin: number | null;
  falseEasting: number | null;
  falseNorthing: number | null;
  scaleFactor: number | null;
  desc?: string;
}

/** Result of {@link SeisconvAPI.spsHeaderList}: the shared H block, the parsed
 *  projection, the loaded file list, and whether the files' H blocks differ. */
export interface SPSHeaderListResult {
  ok: boolean;
  headers: SPSHeaderRow[];
  projection: SPSHeaderProjection | null;
  files: { name: string; type: string }[];
  filesDiffer: boolean;
}

/** Loose CRS rewrite spec sent by the Header Editor (header-only regeneration of
 *  the projection H-records). All fields optional. */
export interface SPSCrsEdit {
  datum?: string;
  projType?: string;
  zone?: number;
  hemi?: 'N' | 'S';
  units?: string;
  centralMeridian?: number;
  latOrigin?: number;
  falseEasting?: number;
  falseNorthing?: number;
  scaleFactor?: number;
}

/** The edit/add/remove (+ optional CRS) batch the Header Editor applies. `scope`
 *  is 'shared' (all loaded SPS files) or a single loaded file's name. */
export interface SPSApplyHeadersReq {
  scope: 'shared' | string;
  // `oldVal` (optional) targets a specific record by code+value so two records
  // sharing a code aren't edited/removed together. A bare `string` remove is the
  // code-only form (kept for back-compat).
  edits: { code: string; val: string; oldVal?: string }[];
  adds: { code: string; desc?: string; val: string }[];
  removes: (string | { code: string; oldVal?: string })[];
  crs?: SPSCrsEdit;
}

/** Result of {@link SeisconvAPI.spsApplyHeaders}: ok + the refreshed header list. */
export interface SPSApplyHeadersResult {
  ok: boolean;
  headers: SPSHeaderRow[];
  error?: string;
}

/** Observer Log payload restored from a saved .json (shape matches what the
 *  renderer writes via exportText). Fields are loosely typed — the renderer
 *  reconciles them against its own LogColumn / LogRow types on load. */
export interface LogJson {
  meta: Record<string, string>;
  columns: { key: string; label: string; group: string; type: string; unit?: string; options?: string[] }[];
  rows: Record<string, string | number>[];
}

/** Result of an SNTP "Sync clock" query. `offsetMs` (= serverTimeMs - local
 *  Date.now()) and `serverTimeMs` are present only when ok; otherwise `error`
 *  carries the reason (timeout / DNS failure / offline). */
export interface NtpSyncResult {
  ok: boolean;
  offsetMs?: number;
  serverTimeMs?: number;
  error?: string;
}

/** One SPS source record exposed to the Observer Log for column-linking. The
 *  three optional SPSPoint fields (upholeMs/staticMs/srcType) are null when the
 *  survey didn't carry them. */
export interface SpsSourceRecord {
  lineName: string;
  point: number;
  idx: string;
  easting: number;
  northing: number;
  elevation: number;
  upholeMs: number | null;
  staticMs: number | null;
  srcType: string | null;
}

const api = {
  /** Host OS, for OS-aware key hints (set to process.platform at preload load). */
  platform: process.platform as string,
  /** Open a file picker, parse the chosen file off-thread; returns a summary (or null if cancelled). */
  openAndParse: (): Promise<ParseSummary | null> => ipcRenderer.invoke('seisconv:openAndParse'),
  /** Step ±delta through the seismic files in the open file's folder; parses the
   *  target and returns the same summary shape, or null if the move is a no-op
   *  (already at an edge, or no file open). */
  openSiblingFile: (delta: number): Promise<ParseSummary | null> => ipcRenderer.invoke('seisconv:openSiblingFile', delta),
  /** Get one trace's samples + header from the currently-open file. */
  getTrace: (index: number): Promise<TraceData> => ipcRenderer.invoke('seisconv:getTrace', index),
  /** Trace Workbench: open a single-file picker; returns the chosen path (no parse) or null. */
  pickTraceFile: (): Promise<string | null> => ipcRenderer.invoke('seisconv:pickTraceFile'),
  /** Trace Workbench: parse `path` locally and pull ONE trace (samples + header + source meta). */
  extractTrace: (path: string, index: number): Promise<ExtractedTrace> => ipcRenderer.invoke('seisconv:extractTrace', path, index),
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
  /** Trace Workbench EXPORT: write the collected traces out as a seismic file in
   *  `format` and save via a native dialog. `sampleInt` (µs) is stamped on the
   *  synthetic file (the collection's first trace); `baseName` (no extension)
   *  seeds the dialog's default name. */
  convertTraces: (args: { traces: { samples: Float32Array; nSamples: number; sampleInt?: number }[]; sampleInt?: number; format: string; baseName?: string }): Promise<ConvertResult> =>
    ipcRenderer.invoke('seisconv:convertTraces', args),
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
  /** Clear ONLY the loaded SPS survey in the worker (keeps any open seismic file). */
  spsClear: (): Promise<void> => ipcRenderer.invoke('seisconv:spsClear'),
  /** Get the loaded P6/11 bin grid (or null when none is loaded). */
  binGrid: (): Promise<BinGridInfo | null> => ipcRenderer.invoke('seisconv:binGrid'),
  /** Get line-grouped survey geometry (projected E/N, or WGS84 lon/lat when geo=true). */
  spsGeometry: (geo: boolean): Promise<SpsGeometry> => ipcRenderer.invoke('seisconv:spsGeometry', geo),
  /** Get shot→receiver "spider" segments (projected E/N, or WGS84 lon/lat when geo=true). */
  spsXrefLines: (geo: boolean): Promise<SpsXrefLines> => ipcRenderer.invoke('seisconv:spsXrefLines', geo),
  /** Get the CMP-midpoint FOLD / coverage bin map (projected E/N) for the given bin size. */
  spsFold: (opts: { binX: number; binY: number }): Promise<SpsFold> => ipcRenderer.invoke('seisconv:spsFold', opts),
  /** Run survey QC on the loaded SPS data. */
  spsQC: (qc?: { srcInt?: number; rcvInt?: number; tol?: number; maxOff?: number; maxSrc?: number; maxRcv?: number }): Promise<QCRow[]> =>
    ipcRenderer.invoke('seisconv:spsQC', qc ?? {}),
  /** Fetch the full field set of one source/receiver point; null if not found / no SPS. */
  spsPointDetail: (args: { rtype: 'S' | 'R'; lineName: string; point: number; idx?: string }): Promise<SPSPointDetail | null> =>
    ipcRenderer.invoke('seisconv:spsPointDetail', args),
  /** Reproject the loaded SPS survey to an EPSG target and save a ZIP. */
  spsReproject: (code: string): Promise<ConvertResult> => ipcRenderer.invoke('seisconv:spsReproject', code),
  /** SPS Header Viewer: get the shared H block (code/val/raw/desc), the parsed
   *  projection, the loaded-file list, and whether the files' H blocks differ. */
  spsHeaderList: (): Promise<SPSHeaderListResult> => ipcRenderer.invoke('seisconv:spsHeaderList'),
  /** SPS Header Editor: apply an edit/add/remove batch (+ optional CRS rewrite)
   *  to the loaded survey's H block(s); re-parses in the worker and returns the
   *  refreshed header list. Does not save to disk (see spsSaveCorrected). */
  spsApplyHeaders: (req: SPSApplyHeadersReq): Promise<SPSApplyHeadersResult> => ipcRenderer.invoke('seisconv:spsApplyHeaders', req),
  /** SPS Header Editor: save the current (edited) SPS files to disk as a .zip. */
  spsSaveCorrected: (): Promise<ConvertResult> => ipcRenderer.invoke('seisconv:spsSaveCorrected'),
  /** Export the loaded SPS survey as KML / GeoJSON / a CSV trio / a QC-report CSV.
   *  Multi-file output (csv) is saved as a ZIP; single-file output via a Save dialog. */
  spsExport: (args: { kind: 'kml' | 'geojson' | 'csv' | 'qcreport' | 'p111' | 'coordcsv'; qcParams?: { srcInt?: number; rcvInt?: number; tol?: number; maxOff?: number; maxSrc?: number; maxRcv?: number } }): Promise<ConvertResult> =>
    ipcRenderer.invoke('seisconv:spsExport', args),
  /** Compute an NMO semblance panel for the open file. */
  semblance: (opts: { velMin: number; velMax: number; velStep: number }): Promise<SemblanceData> => ipcRenderer.invoke('seisconv:semblance', opts),
  /** Spectrum Analysis: mean amplitude spectrum over the open file (or the
   *  [traceStart,traceEnd) trace window). Trace count is decimated when huge. */
  avgSpectrum: (opts?: { traceStart?: number; traceEnd?: number }): Promise<AvgSpectrumData> => ipcRenderer.invoke('seisconv:avgSpectrum', opts ?? {}),
  /** Spectrum Analysis: STFT spectrogram of trace `index` (winLen samples, hop =
   *  winLen/2 by default). Returns a row-major nFrames×nBins magnitude grid. */
  spectrogram: (opts: { index: number; winLen?: number; hop?: number }): Promise<SpectrogramData> => ipcRenderer.invoke('seisconv:spectrogram', opts),
  /** Spectrum Analysis: 2-D f-k spectrum of the section (`dx` = trace spacing,
   *  default 1). Returns a row-major nF×nKx magnitude grid, kx fftshifted. */
  fk: (opts?: { dx?: number }): Promise<FkData> => ipcRenderer.invoke('seisconv:fk', opts ?? {}),
  /** Save arbitrary text (e.g. velocity picks CSV) via a native dialog. */
  exportText: (name: string, text: string): Promise<ConvertResult> => ipcRenderer.invoke('seisconv:exportText', { name, text }),
  /** Save arbitrary binary bytes (e.g. a renderer-built .xlsx / .ods) via a native dialog. */
  exportBinary: (name: string, bytes: Uint8Array): Promise<ConvertResult> => ipcRenderer.invoke('seisconv:exportBinary', { name, bytes }),
  /** Observer Log RELOAD: open a .json picker, parse it, return {meta,columns,rows} (or null). */
  openLogJson: (): Promise<LogJson | null> => ipcRenderer.invoke('seisconv:openLogJson'),
  /** Observer Log TEMPLATE import: open a .json picker, parse it, return the RAW
   *  parsed object (the renderer validates the template shape) or null if cancelled. */
  openTemplateJson: (): Promise<unknown> => ipcRenderer.invoke('seisconv:openTemplateJson'),
  /** Observer Log "Sync clock": query an SNTP server over UDP; resolves the offset
   *  (serverTimeMs - local Date.now()) or { ok:false, error }. Defaults to 'pool.ntp.org'. */
  ntpSync: (server: string): Promise<NtpSyncResult> => ipcRenderer.invoke('seisconv:ntpSync', server),
  /** Observer Log SPS-linking: flat list of the loaded survey's source records
   *  ([] when no SPS is loaded) for columns linked to an SPS source field. */
  spsSourceList: (): Promise<{ sources: SpsSourceRecord[] }> => ipcRenderer.invoke('seisconv:spsSourceList'),
  /** Current application-wide UI zoom factor (1 = 100 %); reads webFrame state. */
  getZoom: (): number => webFrame.getZoomFactor(),
  /** Set the application-wide UI zoom factor (clamped to 0.5–2.5) via webFrame. */
  setZoom: (factor: number): void => webFrame.setZoomFactor(clampZoom(factor)),
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
