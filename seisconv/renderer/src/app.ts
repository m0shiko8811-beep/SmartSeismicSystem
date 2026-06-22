// SeisConv renderer — entry. Bundled by esbuild (platform=browser) to
// renderer/dist/app.js. Talks only to window.seisconvAPI (preload bridge);
// never touches Node/fs directly. Pure render helpers come from core.

import { normFactorPercentile } from '../../core/render/model';
import { getColor, colorViridis } from '../../core/render/colormaps';
import { EPSG_DB } from '../../core/sps/reproject';
import { amplitudeSpectrum } from '../../core/dsp/fft';
import { crossCorrelate, difference } from '../../core/dsp/correlate';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

type Summary = {
  path: string;
  name: string;
  format: string;
  revision: number;
  traceCount: number;
  samplesTrace: number | null;
  sampleInt: number | null;
  errors: string[];
  // Sibling-file navigation (open file's folder): 0-based index, total count,
  // and edge flags. Present on every open/openSiblingFile result.
  index: number;
  count: number;
  hasPrev: boolean;
  hasNext: boolean;
};
type TraceData = { index: number; nSamples: number; sampleInt: number; hdr: Record<string, number | string>; samples: Float32Array };
// One trace pulled from an arbitrary file by the Trace Workbench (extractTrace):
// TraceData plus the source file name + total trace count, for labelling/clamping.
type ExtractedTrace = { name: string; index: number; traceCount: number; nSamples: number; sampleInt: number; hdr: Record<string, number | string>; samples: Float32Array };
type SectionOpts = { maxTraces?: number; maxSamples?: number; traceStart?: number; traceEnd?: number; sampStart?: number; sampEnd?: number; agc?: boolean; agcType?: 'rms' | 'median' | 'mean'; agcWindowMs?: number };
type SectionData = { numTraces: number; colLen: number; norm: number; sampleInt: number; traceStep: number; data: Float32Array; traceStart: number; traceEnd: number; sampStart: number; sampEnd: number; fullTraces: number; fullSamples: number };
type SpsSummary = { sources: number; receivers: number; xrefs: number; layout: string | null; projection: { type: string | null; subtype: string | null; desc?: string } | null; errors: string[] };
type SpsLines = { x: Float32Array; y: Float32Array; line: Int32Array; pt: Float32Array; names: string[] };
type SpsGeometry = { geo: boolean; src: SpsLines; rcv: SpsLines; bbox: { minX: number; maxX: number; minY: number; maxY: number } };
type SpsXrefLines = { geo: boolean; sx: Float32Array; sy: Float32Array; rx: Float32Array; ry: Float32Array; shot: Int32Array; shotKeys: string[]; decimated: boolean; log: string };
type SpsFold = { nx: number; ny: number; binX: number; binY: number; originX: number; originY: number; fold: Int32Array; maxFold: number; totalMid: number; decimated: boolean; log: string };
type QCParamsUI = { srcInt?: number; rcvInt?: number; tol?: number; maxOff?: number };
type QCPoint = { rtype: 'S' | 'R'; lineName: string; point: number; easting: number; northing: number };
type QCRow = { sev: string; cat: string; msg: string; pts?: QCPoint[] };
type SPSPointDetail = {
  rtype: 'S' | 'R'; lineName: string; point: number; idx: string;
  easting: number; northing: number; elevation: number; raw: string;
  upholeMs?: number; srcType?: string; date?: string; time?: string; ffid?: number; staticMs?: number;
};
type SemblanceData = { semb: Float32Array; vels: number[]; nT: number; dt: number; siUs: number; offNote: string };
type VelPick = { v: number; tMs: number };

// ── Converter contract (folder-batch) types ──
type ConvResult = { ok: boolean; path?: string; canceled?: boolean; error?: string };
type FolderFile = { name: string; path: string };
type PickFolderResult = { dir: string; files: FolderFile[] } | null;
type BatchSummary = {
  ok: boolean;
  total: number;
  done: number;
  failed: number;
  canceled: boolean;
  results: { name: string; ok: boolean; error?: string }[];
};
type ConvProgress = {
  index: number;
  total: number;
  file: string;
  state: 'start' | 'done' | 'error' | 'cancelled' | 'finished';
  error?: string;
};

// The renderer is the sole owner of the `window.seisconvAPI` type. The preload
// backend implements the SAME contract (channel names + signatures) in parallel;
// declaring the shape here keeps the renderer compiling even if the backend
// types are not yet present, and documents exactly what the UI relies on.
declare global {
  interface Window {
    seisconvAPI: {
      // OS for key hints ('win32' | 'darwin' | 'linux' | …), set at preload load.
      platform: string;
      openAndParse(): Promise<Summary | null>;
      // Step ±delta through the seismic files in the open file's folder; null on a no-op.
      openSiblingFile(delta: number): Promise<Summary | null>;
      getTrace(i: number): Promise<TraceData>;
      // Trace Workbench: single-file picker (no parse) → chosen path or null.
      pickTraceFile(): Promise<string | null>;
      // Trace Workbench: parse `path` locally and pull ONE trace + source meta.
      extractTrace(path: string, index: number): Promise<ExtractedTrace>;
      getSection(o?: SectionOpts): Promise<SectionData>;
      // Single-file conversion of the currently-open file (save dialog).
      // `outBaseName` (no extension) becomes the dialog's default file name.
      convertSingle(format: string, outBaseName?: string): Promise<ConvResult>;
      // Trace Workbench EXPORT: write the collected traces out as a seismic file
      // in `format` (save dialog). `sampleInt` (µs) stamps the synthetic file;
      // `baseName` (no extension) seeds the dialog's default name.
      convertTraces(args: { traces: { samples: Float32Array; nSamples: number; sampleInt?: number }[]; sampleInt?: number; format: string; baseName?: string }): Promise<ConvResult>;
      // Folder picker → enumerated seismic files; null if cancelled / none.
      pickInputFolder(): Promise<PickFolderResult>;
      // Destination-folder picker; null if cancelled.
      pickOutputFolder(): Promise<string | null>;
      // Batch-convert a set of files into outDir, emitting per-file progress.
      // Names each output via `nameTemplate` ({name}/{fmt}/{date}/{n}) + `dateStr`.
      batchConvert(opts: { files: FolderFile[]; format: string; outDir: string; nameTemplate?: string; dateStr?: string }): Promise<BatchSummary>;
      // Subscribe to per-file conversion progress; returns an unsubscribe fn.
      onConvertProgress(cb: (p: ConvProgress) => void): () => void;
      // Signal a running batch to stop.
      cancelConvert(): void;
      // Clear the open file + cached state in the worker.
      resetState(): Promise<void>;
      openSPS(): Promise<SpsSummary | null>;
      spsGeometry(geo: boolean): Promise<SpsGeometry>;
      spsXrefLines(geo: boolean): Promise<SpsXrefLines>;
      spsFold(opts: { binX: number; binY: number }): Promise<SpsFold>;
      spsQC(qc?: QCParamsUI): Promise<QCRow[]>;
      spsPointDetail(args: { rtype: 'S' | 'R'; lineName: string; point: number; idx?: string }): Promise<SPSPointDetail | null>;
      spsReproject(code: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
      spsExport(args: { kind: 'kml' | 'geojson' | 'csv' | 'qcreport'; qcParams?: QCParamsUI }): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
      semblance(opts: { velMin: number; velMax: number; velStep: number }): Promise<SemblanceData>;
      exportText(name: string, text: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
      // App-wide UI zoom (whole interface), backed by Electron's webFrame.
      getZoom(): number;
      setZoom(factor: number): void;
      // Custom window controls — the frameless window draws its own min/max/close.
      winMinimize(): void;
      winMaximizeToggle(): void;
      winClose(): void;
      onWinMaximized(cb: (maximized: boolean) => void): () => void;
    };
  }
}
const api = window.seisconvAPI;
const $ = (id: string) => document.getElementById(id) as HTMLElement;
/** Optional lookup — returns null instead of throwing when an id is absent. */
const $opt = (id: string) => document.getElementById(id);

// ── Theme (GUI C: light default + working dark toggle, persisted) ──
type Theme = 'light' | 'dark';
function applyTheme(t: Theme) {
  document.documentElement.setAttribute('data-theme', t);
  $opt('themeLight')?.classList.toggle('on', t === 'light');
  $opt('themeDark')?.classList.toggle('on', t === 'dark');
  try { localStorage.setItem('seisconv.theme', t); } catch { /* ignore */ }
  // Plot canvases keep their dark scientific background in both themes, so
  // re-draw whatever is visible to refresh chrome-derived colors if needed.
  if (lastTrace && $opt('panel-trace')?.style.display !== 'none') renderTrace();
  if (lastSection && $opt('panel-section')?.style.display !== 'none') redrawSection();
}
function initTheme() {
  let t: Theme = 'light';
  try { const s = localStorage.getItem('seisconv.theme'); if (s === 'dark' || s === 'light') t = s; } catch { /* ignore */ }
  applyTheme(t);
  $opt('themeLight')?.addEventListener('click', () => applyTheme('light'));
  $opt('themeDark')?.addEventListener('click', () => applyTheme('dark'));
}

// ── App-wide UI zoom (whole interface, like a browser's Ctrl +/- / Ctrl 0) ──
// Backed by Electron's webFrame (exposed through the preload bridge). The factor
// is clamped to 0.5–2.5 in ~0.1 steps, persisted in localStorage, applied on
// init, and mirrored into the status-bar [-] 100% [+] control.
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.1;
const ZOOM_KEY = 'seisconv.zoom';
let zoomFactor = 1;

/** Clamp to range and round to a clean 0.1 step (avoids float drift like 1.0000001). */
function clampZoom(f: number): number {
  if (!Number.isFinite(f)) return 1;
  const stepped = Math.round(f / ZOOM_STEP) * ZOOM_STEP;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(stepped * 100) / 100));
}

/** Apply a zoom factor everywhere: webFrame, persisted store, and the status-bar control. */
function applyZoom(f: number) {
  zoomFactor = clampZoom(f);
  try { api?.setZoom?.(zoomFactor); } catch { /* ignore */ }
  try { localStorage.setItem(ZOOM_KEY, String(zoomFactor)); } catch { /* ignore */ }
  const pct = $opt('zoomPct');
  if (pct) pct.textContent = `${Math.round(zoomFactor * 100)}%`;
}
/** Nudge the zoom by N steps (sign = direction). */
function zoomBy(steps: number) { applyZoom(zoomFactor + steps * ZOOM_STEP); }
function zoomReset() { applyZoom(1); }

function initZoom() {
  let f = 1;
  try { const s = localStorage.getItem(ZOOM_KEY); if (s != null) f = parseFloat(s); } catch { /* ignore */ }
  applyZoom(f); // clamps, pushes to webFrame, paints the control
  $opt('zoomIn')?.addEventListener('click', () => zoomBy(1));
  $opt('zoomOut')?.addEventListener('click', () => zoomBy(-1));
  $opt('zoomPct')?.addEventListener('click', () => zoomReset());
}

// ── Help / Manual modal ──
function openManual() { $opt('manualBack')?.classList.add('open'); }
function closeManual() { $opt('manualBack')?.classList.remove('open'); }
function manualOpen(): boolean { return !!$opt('manualBack')?.classList.contains('open'); }

/** Replace every hard-coded key glyph with an OS-aware label (Ctrl on win32, Cmd on darwin). */
function applyKeyHints() {
  // bottom tip line on the Converter
  const tip = $opt('convTip');
  if (tip) {
    tip.innerHTML =
      `Tip — <span class="kbd">${KEY_OPEN}</span> open · ` +
      `<span class="kbd">${KEY_BATCH}</span> batch · ` +
      `<span class="kbd">1–6</span> switch tabs · ` +
      `<span class="kbd">?</span> help.`;
  }
  // rail + header tooltips
  $opt('railHelp')?.setAttribute('title', `Help / Manual — keys: ${KEY_OPEN} open · ${KEY_BATCH} batch · 1–6 tabs · ? help`);
  $opt('helpBtn')?.setAttribute('title', `Help / Manual (?)`);
  $opt('openBtn')?.setAttribute('title', `Open a seismic file (${KEY_OPEN})`);
  // in-manual key chips that carry a data-key marker
  document.querySelectorAll<HTMLElement>('.kbd[data-key]').forEach((el) => {
    const k = el.getAttribute('data-key');
    if (k === 'open') el.textContent = KEY_OPEN;
    else if (k === 'batch') el.textContent = KEY_BATCH;
    else if (k === 'tabs') el.textContent = '1–6';
    else if (k === 'help') el.textContent = '?';
  });
}

// Tab chrome metadata (title + breadcrumb + description in the tab header).
const TAB_META: Record<string, { title: string; desc: string }> = {
  conv: { title: 'Converter', desc: 'Read SEG-Y · SEG-D · SEG-2 / .dat · SU off the UI thread, then export to any supported format.' },
  trace: { title: 'Trace Inspector', desc: 'Step through individual traces; inspect the waveform or amplitude spectrum.' },
  section: { title: 'File Viewer', desc: 'Render the full record as a variable-density / wiggle section with gain and AGC.' },
  sps: { title: 'SPS 2.1', desc: 'Plot source/receiver geometry on a survey grid or real basemap; QC and reproject.' },
  vel: { title: 'Velocity', desc: 'Compute an NMO semblance panel and pick a stacking-velocity function.' },
  workbench: { title: 'Trace Workbench', desc: 'Collect individual traces from any file and compare them side-by-side or overlaid, zoomed in lock-step.' },
};

let summary: Summary | null = null;
let traceIndex = 0;
let lastTrace: TraceData | null = null;
let traceMode: 'wave' | 'spectrum' = 'wave';
// Trace Inspector time-axis zoom: the visible sample window [s0,s1) (end
// exclusive) within the FULL trace, which is already in lastTrace.samples — so
// zoom/pan is renderer-only (no worker fetch). `fullS` caches the trace length
// for clamping; init=false ⇒ "fit whole trace" (reset on every new trace).
const traceView = { s0: 0, s1: 0, fullS: 0, init: false };
let outFormat = 'segy1';
let lastSection: SectionData | null = null;
// Section data-zoom view-state: the visible window in FULL-data indices
// (trace t0..t1, sample s0..s1, end exclusive). The worker re-decimates this
// window at full detail on every change, so zoom reveals real samples. `full*`
// caches the record extent for clamping; init=false ⇒ "fit whole record".
const secView = { t0: 0, t1: 0, s0: 0, s1: 0, fullT: 0, fullS: 0, init: false };
let secFetchPending = false; // coalesce rapid wheel/drag re-fetches
// File Viewer "click-to-add" mode: when on, a (non-drag) click on the section
// canvas sends the trace under the cursor to the Trace Workbench (#secToWb toggle).
let secToWb = false;
let spsSummary: SpsSummary | null = null;
let spsGeom: SpsGeometry | null = null;
// X-ref spider (shot→receiver segments). Cached like spsGeom; cleared when the
// geometry space (grid E/N vs map lon/lat) changes so endpoints stay valid.
let spsSpider: SpsXrefLines | null = null;
// FOLD / coverage bin map (projected E/N). Cached and re-fetched on bin-size
// change or a new SPS load; `spsFoldBin` records the bin the cache was built for.
let spsFold: SpsFold | null = null;
let spsFoldBin = 0;
// 'srcLine|srcPt' of the shot whose fan is currently emphasized (null = none).
let highlightedShot: string | null = null;
let spsView: 'grid' | 'map' = 'grid';
const gridView = { sc: 1, ox: 0, oy: 0, init: false }; // canvas pan/zoom: x_px = ox + e*sc, y_px = oy - n*sc
let leafletMap: L.Map | null = null;
let leafletLayers: { src: L.LayerGroup; rcv: L.LayerGroup } | null = null;
// Highlight ring for a clicked / jumped-to point. Grid coords are in the CURRENT
// geometry space (projected E/N when geo=false, lon/lat when geo=true) so the
// ring tracks pan/zoom; null clears it. The Leaflet ring is a live map layer.
let gridHighlight: { x: number; y: number } | null = null;
let mapHighlight: L.CircleMarker | null = null;
let velResult: SemblanceData | null = null;
let velPicks: VelPick[] = [];

// ── Trace Workbench state ──
// A collection of traces pulled from arbitrary files (or the open file), drawn
// side-by-side or overlaid and zoomed/panned together. Each entry owns its full
// sample buffer + a distinct colour; `wbView` is the shared time window (sample
// indices, end exclusive) spanning the longest trace, mirroring the inspector's
// traceView so all traces zoom/pan in lock-step and stay aligned.
type WbTrace = {
  id: number;
  sourceName: string;
  traceIndex: number;
  samples: Float32Array;
  sampleInt: number;
  nSamples: number;
  color: string;
};
let wbTraces: WbTrace[] = [];
let wbNextId = 1;
let wbMode: 'side' | 'overlay' = 'side';
const wbView = { s0: 0, s1: 0, fullS: 0, init: false };
// Distinct, theme-friendly colours cycled across collected traces.
const WB_COLORS = ['#34dbd0', '#ffb454', '#7aa2ff', '#ff6e9c', '#9be564', '#c792ea', '#f78c6c', '#56d4ff'];

// ── Converter (single / folder-batch) state ──
type ConvMode = 'single' | 'batch';
let convMode: ConvMode = 'single';
let batchFiles: FolderFile[] = [];
let batchDir = '';
let batchOutDir = '';
let batchRunning = false;
let convProgressOff: (() => void) | null = null;
// 'win32' → Windows; default to a Mac glyph hint only when actually on darwin.
const PLATFORM = (typeof api?.platform === 'string' ? api.platform : 'win32');
const IS_MAC = PLATFORM === 'darwin';
const MOD = IS_MAC ? 'Cmd' : 'Ctrl';      // primary modifier label
const KEY_OPEN = `${MOD}+O`;
const KEY_BATCH = `${MOD}+B`;

const TABS = ['conv', 'trace', 'section', 'sps', 'vel', 'workbench'] as const;
type Tab = (typeof TABS)[number];

function switchTab(tab: Tab) {
  for (const t of TABS) {
    $(`tab-${t}`).classList.toggle('on', t === tab);
    $(`panel-${t}`).style.display = t === tab ? '' : 'none';
  }
  const meta = TAB_META[tab];
  if (meta) {
    const ti = $opt('tabTitle'); if (ti) ti.textContent = meta.title;
    const de = $opt('tabDesc'); if (de) de.textContent = meta.desc;
    const cr = $opt('crumbTab'); if (cr) cr.textContent = meta.title;
  }
  // The Converter has its own in-panel "Open" button; hide the header one there.
  $opt('openBtn')?.classList.toggle('hidden', tab === 'conv');
  if (tab === 'trace' && summary) void refreshTrace();
  if (tab === 'section' && summary) void refreshSection();
  if (tab === 'sps' && spsSummary) void refreshSps();
  if (tab === 'vel' && velResult) drawVelocity();
  if (tab === 'workbench') { drawWorkbench(); wbUpdateAnalysis(); }
}

function fmtRate(si: number | null) {
  return si != null ? `${(si / 1000).toFixed(3)} ms (${si} µs)` : '—';
}

function setStatus(id: string, msg: string, kind = '') {
  const el = $(id);
  el.textContent = msg || '';
  el.className = 'status' + (kind ? ' ' + kind : '');
}

/** Group-thousands integer with a thin space separator (tabular-nums friendly). */
function grp(n: number | null): string {
  if (n == null || !isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US').replace(/,/g, ' ');
}
function setText(id: string, txt: string) { const el = $opt(id); if (el) el.textContent = txt; }

function renderInfo() {
  if (!summary) {
    $('fileInfo').style.display = 'none';
    clearSummaryPanel();
    updateStatusStrip();
    return;
  }
  $('fileInfo').style.display = '';
  $('fiName').textContent = summary.name;
  $('fiBody').textContent =
    `${summary.format}${summary.revision ? ' Rev ' + summary.revision : ''} · ` +
    `${summary.traceCount} traces · ${summary.samplesTrace ?? '—'} samples · ${fmtRate(summary.sampleInt)}` +
    (summary.errors.length ? ` · ⚠ ${summary.errors.length}` : '');
  // enable controls that need a file
  ($('convertBtn') as HTMLButtonElement).disabled = !(summary.traceCount > 0);
  renderSummaryPanel();
  renderHeaderQc();
  updateStatusStrip();
}

/** Right-rail File-summary card, populated from the openAndParse summary. */
function renderSummaryPanel() {
  if (!summary) { clearSummaryPanel(); return; }
  const s = summary;
  const fmtShort = s.format.replace(/^SEG-?Y$/i, 'SEG-Y');
  setText('fsFormat', fmtShort + (s.revision ? ' R' + s.revision : ''));
  setText('fsTraces', grp(s.traceCount));
  setText('fsSamples', grp(s.samplesTrace));
  setText('fsInterval', s.sampleInt != null ? `${(s.sampleInt / 1000).toFixed(3)} ms` : '—');
  const recMs = s.samplesTrace != null && s.sampleInt != null ? (s.samplesTrace * s.sampleInt) / 1e6 : null;
  setText('fsRecord', recMs != null ? `${recMs.toFixed(3)} s` : '—');
  setText('fsData', s.format || '—');
  setText('fsRevision', s.revision ? `Rev ${s.revision}` : '—');
  setText('fsByteOrder', /seg-?y/i.test(s.format) ? 'big-endian' : '—');
  setText('fsCrs', spsCrsLabel());
}
function clearSummaryPanel() {
  for (const id of ['fsFormat', 'fsTraces', 'fsSamples', 'fsInterval', 'fsRecord', 'fsData', 'fsRevision', 'fsByteOrder', 'fsCrs']) setText(id, '—');
  setText('fsCrs', spsCrsLabel());
}

/** Header-QC indicator: badge in the tab header + pill + flag list, driven by summary.errors. */
function renderHeaderQc() {
  const badge = $opt('hdrQcBadge');
  const pill = $opt('hdrQcPill');
  const list = $opt('hdrQcList');
  if (!summary) {
    if (badge) { badge.className = 'pill neutral'; badge.innerHTML = '<span class="dot" style="background:var(--ink-4)"></span>No file'; }
    if (pill) { pill.className = 'pill neutral'; pill.textContent = '—'; }
    if (list) list.innerHTML = '<div class="fl"><span class="pill neutral" style="justify-self:start">—</span><span class="msg">Open a file to run header QC.</span><span class="cat"></span></div>';
    return;
  }
  const errs = summary.errors;
  const n = errs.length;
  if (badge) {
    if (n === 0) { badge.className = 'pill green'; badge.innerHTML = '<span class="dot" style="background:var(--green)"></span>Headers OK'; }
    else { badge.className = 'pill amber'; badge.innerHTML = `<span class="dot" style="background:var(--amber)"></span>${n} flag${n > 1 ? 's' : ''}`; }
  }
  if (pill) {
    if (n === 0) { pill.className = 'pill green'; pill.textContent = 'OK'; }
    else { pill.className = 'pill amber'; pill.textContent = `${n} warning${n > 1 ? 's' : ''}`; }
  }
  if (list) {
    list.innerHTML = '';
    if (n === 0) {
      const fl = document.createElement('div');
      fl.className = 'fl';
      fl.innerHTML = '<span class="pill green" style="justify-self:start">OK</span><span class="msg">No header issues detected.</span><span class="cat"></span>';
      list.appendChild(fl);
    } else {
      for (const e of errs) {
        const fl = document.createElement('div');
        fl.className = 'fl';
        const sev = document.createElement('span');
        sev.className = 'pill amber';
        sev.style.justifySelf = 'start';
        sev.textContent = 'WARN';
        const msg = document.createElement('span');
        msg.className = 'msg';
        msg.textContent = e;
        const cat = document.createElement('span');
        cat.className = 'cat';
        list.appendChild(fl);
        fl.appendChild(sev);
        fl.appendChild(msg);
        fl.appendChild(cat);
      }
    }
  }
}

/** Best-known CRS string from a loaded SPS survey, else a dash. */
function spsCrsLabel(): string {
  const p = spsSummary?.projection;
  if (!p) return '—';
  return p.desc || p.type || p.subtype || '—';
}

/** Bottom status strip: file · dt · traces · fmt · CRS + activity state. */
function updateStatusStrip() {
  if (!summary) {
    setText('sbFile', '—'); setText('sbDt', '—'); setText('sbTraces', '—'); setText('sbFmt', '—');
    setText('sbCrs', spsCrsLabel());
    setState('idle', 'Idle');
    return;
  }
  setText('sbFile', summary.name);
  setText('sbDt', summary.sampleInt != null ? `${(summary.sampleInt / 1000).toFixed(3)} ms` : '—');
  setText('sbTraces', grp(summary.traceCount));
  setText('sbFmt', `${summary.format}${summary.revision ? ' Rev ' + summary.revision : ''}`);
  setText('sbCrs', spsCrsLabel());
}

type StripState = 'idle' | 'busy' | 'ok' | 'err';
function setState(kind: StripState, label: string) {
  const el = $opt('sbState');
  if (!el) return;
  const col = kind === 'busy' ? 'var(--teal)' : kind === 'ok' ? 'var(--green)' : kind === 'err' ? 'var(--red)' : 'var(--ink-4)';
  const txtCol = kind === 'busy' ? 'var(--teal-deep)' : kind === 'ok' ? 'var(--green)' : kind === 'err' ? 'var(--red)' : 'var(--ink-2)';
  el.innerHTML = `<span class="dot" style="background:${col}"></span><b style="color:${txtCol}">${label}</b>`;
}

/**
 * Adopt a freshly-parsed file (from the open dialog OR a Prev/Next sibling step)
 * as the loaded file: store its summary, reset the trace cursor, repaint the
 * info/summary/QC panels + single-file wizard, refresh the file-nav label, and
 * re-render whichever QC view is visible. Shared by onOpen and the sibling-nav so
 * both paths behave identically.
 */
function applyOpenedFile(s: Summary) {
  summary = s;
  traceIndex = 0;
  renderInfo();
  showSingleLoaded();      // banner + light up the single-file wizard
  updateNamePreview();
  updateFileNav();         // Prev/Next enable + 'X / N' label
  setStatus('convStatus', '');
  setState('ok', s.errors.length ? `Loaded · ${s.errors.length} flag${s.errors.length > 1 ? 's' : ''}` : 'Loaded');
  if ($('panel-trace').style.display !== 'none') void refreshTrace();
  if ($('panel-section').style.display !== 'none') void refreshSection();
}

async function onOpen() {
  setStatus('convStatus', 'Opening…');
  setState('busy', 'Opening…');
  try {
    const s = await api.openAndParse();
    if (!s) {
      setStatus('convStatus', '');
      updateStatusStrip();
      return;
    }
    applyOpenedFile(s);
  } catch (e) {
    setStatus('convStatus', 'Could not read file: ' + errMsg(e), 'err');
    setState('err', 'Open failed');
  }
}

/** Refresh the File Viewer's Prev/Next buttons + 'file X / N' label from `summary`. */
function updateFileNav() {
  const prev = $opt('filePrevBtn') as HTMLButtonElement | null;
  const next = $opt('fileNextBtn') as HTMLButtonElement | null;
  const lbl = $opt('fileNavLabel');
  if (!summary || summary.count <= 0) {
    if (prev) prev.disabled = true;
    if (next) next.disabled = true;
    if (lbl) lbl.textContent = summary ? '' : '—';
    return;
  }
  if (prev) prev.disabled = !summary.hasPrev;
  if (next) next.disabled = !summary.hasNext;
  if (lbl) lbl.textContent = `file ${summary.index + 1} / ${summary.count}`;
}

/** Step ±delta to a sibling file in the open file's folder; no-op when none loaded. */
async function navFile(delta: number) {
  if (!summary) return;                 // guard: nothing loaded
  if (delta < 0 && !summary.hasPrev) return;
  if (delta > 0 && !summary.hasNext) return;
  setState('busy', delta < 0 ? 'Opening previous…' : 'Opening next…');
  try {
    const s = await api.openSiblingFile(delta);
    if (!s) { updateFileNav(); updateStatusStrip(); return; } // edge / no move
    applyOpenedFile(s);                 // updates summary, re-renders, resets trace
  } catch (e) {
    setStatus('convStatus', 'Could not read file: ' + errMsg(e), 'err');
    setState('err', 'Open failed');
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  CONVERTER — two modes: single file & folder (batch)
// ══════════════════════════════════════════════════════════════════════════

const FMT_LABEL: Record<string, string> = {
  segy1: 'SEG-Y Rev 1', segy0: 'SEG-Y Rev 0', segy2: 'SEG-Y Rev 2',
  su: 'Seismic Unix', seg2: 'SEG-2 / .dat', segd1: 'SEG-D Rev 1',
  segd3: 'SEG-D Rev 3', tpimage: 'Tape Image', csv: 'CSV / ASCII',
};
function fmtLabel(f: string): string { return FMT_LABEL[f] || f.toUpperCase(); }

// Output extension per writer id (mirrors core/formats/registry.ts writers; used
// for the output-name preview — the backend is the source of truth on write).
const FMT_EXT: Record<string, string> = {
  segy1: 'sgy', segy0: 'sgy', segy2: 'sgy',
  su: 'su', seg2: 'dat', segd1: 'segd',
  segd3: 'segd', tpimage: 'tpimage', csv: 'csv',
};
function fmtExt(f: string): string { return FMT_EXT[f] || 'bin'; }

// ── Output-name templating ──────────────────────────────────────────────────
// A small token engine shared by single + batch. Tokens: {name} input base,
// {fmt} writer id, {date} YYYYMMDD stamp, {n} 1-based index (batch only).

/** Strip the final extension from a file name → its base. */
function fileBase(name: string): string { return name.replace(/\.[^.]+$/, ''); }

/** Strip characters illegal in file names so a templated base is always safe. */
function sanitizeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || 'output';
}

/** Read the date input as a YYYYMMDD stamp; falls back to today if empty/invalid. */
function dateStamp(): string {
  const raw = ($opt('outNameDate') as HTMLInputElement | null)?.value || '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw.replace(/-/g, '');
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** Current template string (default if the field is empty). */
function nameTemplate(): string {
  const raw = ($opt('outNameTpl') as HTMLInputElement | null)?.value || '';
  return raw.trim() || '{name}_{fmt}_{date}';
}

/** Apply the template for one file → a safe base name (no extension). */
function applyNameTemplate(tpl: string, vars: { name: string; fmt: string; date: string; n?: number }): string {
  const out = tpl
    .replace(/\{name\}/g, vars.name)
    .replace(/\{fmt\}/g, vars.fmt)
    .replace(/\{date\}/g, vars.date)
    .replace(/\{n\}/g, vars.n != null ? String(vars.n) : '');
  return sanitizeName(out);
}

/** Refresh the live filename preview for the active mode. */
function updateNamePreview() {
  const ext = fmtExt(outFormat);
  setText('outNameExt', '.' + ext);
  const tpl = nameTemplate();
  const date = dateStamp();
  const prev = $opt('outNamePreview');
  if (!prev) return;
  if (convMode === 'batch') {
    const sample = batchFiles[0]?.name;
    const base = sample ? fileBase(sample) : 'example';
    const out = applyNameTemplate(tpl, { name: base, fmt: outFormat, date, n: 1 });
    prev.textContent = batchFiles.length
      ? `Preview (file 1 of ${batchFiles.length}) — ${out}.${ext}`
      : `Preview — ${out}.${ext}`;
  } else {
    const base = summary ? fileBase(summary.name) : 'example';
    const out = applyNameTemplate(tpl, { name: base, fmt: outFormat, date });
    prev.textContent = `Preview — ${out}.${ext}`;
  }
  prev.className = 'status';
}

/**
 * Move the shared output-name card into the slot for the active mode. Both modes
 * read the same #outNameTpl/#outNameDate/#outNamePreview ids, so the template
 * engine keeps working regardless of where the card currently lives in the DOM —
 * single mode hosts it inside wizard step 3, batch mode above the folder wizard.
 */
function relocateOutNameCard(m: ConvMode) {
  const card = $opt('outNameCard');
  const slot = $opt(m === 'single' ? 'outNameSlotSingle' : 'outNameSlotBatch');
  if (card && slot && card.parentElement !== slot) slot.appendChild(card);
}

/** Switch the Converter between single-file and folder-batch modes. */
function setConvMode(m: ConvMode) {
  if (batchRunning) return; // don't tear the UI out from under a running batch
  convMode = m;
  $opt('modeSingle')?.classList.toggle('sel', m === 'single');
  $opt('modeBatch')?.classList.toggle('sel', m === 'batch');
  $opt('modeSingle')?.setAttribute('aria-pressed', String(m === 'single'));
  $opt('modeBatch')?.setAttribute('aria-pressed', String(m === 'batch'));
  $opt('convSingle')?.classList.toggle('hidden', m !== 'single');
  $opt('convBatch')?.classList.toggle('hidden', m !== 'batch');
  // Host the shared output-name card in the active mode's slot.
  relocateOutNameCard(m);
  // Tape Image is a batch-only writer; if it was picked in batch, fall back to a
  // valid single-mode format when switching to single so the chip stays in sync.
  if (m === 'single' && outFormat === 'tpimage') selectFormat('segy1');
  if (m === 'single') refreshSingleWizard();
  updateNamePreview();
}

/** Mirror the chosen output format onto both chip groups + the shared state. */
function selectFormat(fmt: string) {
  outFormat = fmt;
  for (const groupId of ['fmtChips', 'fmtChipsBatch']) {
    const g = $opt(groupId);
    if (!g) continue;
    for (const b of g.querySelectorAll('button')) b.classList.toggle('sel', b.getAttribute('data-fmt') === fmt);
  }
  if (convMode === 'single') refreshSingleWizard();
  updateNamePreview();
}

/**
 * Light up the single-file wizard steps + gate later steps, mirroring the batch
 * wizard (refreshWizard). Step 1 = a file is open; step 2 = output format chosen
 * (a default is always selected); step 3 = name + Convert & Save. No file → the
 * format chips and the Convert button are disabled, just like batch gates its run.
 */
function refreshSingleWizard() {
  const haveFile = !!summary && summary.traceCount > 0;
  // step 1 — pick file
  $opt('wizStepFile')?.classList.toggle('done', haveFile);
  $opt('wizStepFile')?.classList.toggle('active', !haveFile);
  // step 2 — output format (a format is always pre-selected, so it's done once a file is open)
  $opt('wizStepSingleFormat')?.classList.toggle('done', haveFile);
  $opt('wizStepSingleFormat')?.classList.toggle('active', false);
  // step 3 — name & save (the actionable step once a file is open)
  $opt('wizStepSingleSave')?.classList.toggle('active', haveFile);
  $opt('wizStepSingleSave')?.classList.toggle('done', false);
  // gate: no file → can't pick a format or convert
  const chips = $opt('fmtChips');
  if (chips) for (const b of chips.querySelectorAll('button')) (b as HTMLButtonElement).disabled = !haveFile || batchRunning;
  const conv = $opt('convertBtn') as HTMLButtonElement | null;
  if (conv) conv.disabled = !haveFile || batchRunning;
}

/** Fill the single-file loaded banner (name + format + trace/sample summary) and advance the wizard. */
function showSingleLoaded() {
  const found = $opt('singleFound');
  if (!summary) { found?.classList.toggle('hidden', true); refreshSingleWizard(); return; }
  found?.classList.toggle('hidden', false);
  setText('singleFoundName', summary.name);
  const rev = summary.revision ? ` Rev ${summary.revision}` : '';
  setText('singleFoundMeta',
    `${summary.format}${rev} · ${grp(summary.traceCount)} traces · ${summary.samplesTrace ?? '—'} samples · ${fmtRate(summary.sampleInt)}`);
  setText('wizFileSub', `${summary.format}${rev} — ${grp(summary.traceCount)} traces, ${summary.samplesTrace ?? '—'} samples.`);
  refreshSingleWizard();
}

// ── Single-file convert ──
async function onConvert() {
  if (!summary) return;
  showSingleProgress(true);
  setStatus('convStatus', `Converting → ${fmtLabel(outFormat)}…`);
  setState('busy', 'Converting…');
  ($('convertBtn') as HTMLButtonElement).disabled = true;
  try {
    const outBase = applyNameTemplate(nameTemplate(), { name: fileBase(summary.name), fmt: outFormat, date: dateStamp() });
    const r = await api.convertSingle(outFormat, outBase);
    if (r.ok) { setStatus('convStatus', '✓ Saved ' + r.path, 'ok'); setState('ok', 'Saved'); }
    else if (r.canceled) { setStatus('convStatus', ''); updateStatusStrip(); }
    else { setStatus('convStatus', 'Conversion failed: ' + (r.error || 'unknown'), 'err'); setState('err', 'Convert failed'); }
  } catch (e) {
    setStatus('convStatus', 'Conversion failed: ' + errMsg(e), 'err');
    setState('err', 'Convert failed');
  } finally {
    showSingleProgress(false);
    ($('convertBtn') as HTMLButtonElement).disabled = !(summary && summary.traceCount > 0);
  }
}

function showSingleProgress(on: boolean) {
  $opt('singleProg')?.classList.toggle('hidden', !on);
  const t = $opt('singleProgTitle');
  if (t) t.textContent = `Converting → ${fmtLabel(outFormat)}…`;
}

// ── Folder batch: wizard ──
async function pickBatchFolder() {
  if (batchRunning) return;
  setStatus('batchStatus', 'Choosing folder…');
  try {
    const res = await api.pickInputFolder();
    if (!res) { setStatus('batchStatus', ''); return; }
    batchFiles = res.files;
    batchDir = res.dir;
    const found = $opt('batchFound');
    found?.classList.toggle('hidden', false);
    setText('batchCount', String(res.files.length));
    setText('batchDir', res.dir);
    setText('wizFolderSub', `${res.files.length} seismic file${res.files.length === 1 ? '' : 's'} in this folder.`);
    updateNamePreview();
    $('batchFileList').innerHTML = '';
    setStatus('batchStatus', res.files.length ? '' : 'No seismic files in that folder.', res.files.length ? '' : 'err');
    refreshWizard();
  } catch (e) {
    setStatus('batchStatus', 'Folder scan failed: ' + errMsg(e), 'err');
  }
}

async function pickBatchOut() {
  if (batchRunning) return;
  try {
    const dir = await api.pickOutputFolder();
    if (!dir) return;
    batchOutDir = dir;
    setText('wizDestSub', dir);
    refreshWizard();
  } catch (e) {
    setStatus('batchStatus', 'Destination pick failed: ' + errMsg(e), 'err');
  }
}

/** Light up wizard steps + enable the run button once folder + dest are set. */
function refreshWizard() {
  const haveFiles = batchFiles.length > 0;
  const haveOut = batchOutDir.length > 0;
  $opt('wizStepFolder')?.classList.toggle('done', haveFiles);
  $opt('wizStepFolder')?.classList.toggle('active', !haveFiles);
  $opt('wizStepFormat')?.classList.toggle('active', haveFiles && !haveOut);
  $opt('wizStepFormat')?.classList.toggle('done', haveFiles && haveOut);
  $opt('wizStepDest')?.classList.toggle('done', haveOut);
  $opt('wizStepDest')?.classList.toggle('active', haveFiles && !haveOut);
  const btn = $opt('runBatchBtn') as HTMLButtonElement | null;
  if (btn) btn.disabled = !(haveFiles && haveOut) || batchRunning;
  setText('runBatchLabel', haveFiles ? `Convert ${batchFiles.length} file${batchFiles.length === 1 ? '' : 's'}` : 'Convert files');
}

async function runBatch() {
  if (batchRunning || !batchFiles.length || !batchOutDir) return;
  batchRunning = true;
  setBatchControlsRunning(true);
  // Seed the per-file list so users see the full queue up front.
  buildBatchQueue();
  $opt('batchProg')?.classList.toggle('hidden', false);
  setBatchProgress(0, batchFiles.length, '', fmtLabel(outFormat));
  setStatus('batchStatus', '');
  setState('busy', `Converting 0 / ${batchFiles.length}`);
  try {
    const r = await api.batchConvert({ files: batchFiles, format: outFormat, outDir: batchOutDir, nameTemplate: nameTemplate(), dateStr: dateStamp() });
    finishBatch(r);
  } catch (e) {
    setStatus('batchStatus', 'Batch failed: ' + errMsg(e), 'err');
    setState('err', 'Batch failed');
    batchRunning = false;
    setBatchControlsRunning(false);
    refreshWizard();
  }
}

function cancelBatch() {
  if (!batchRunning) return;
  api.cancelConvert();
  setStatus('batchStatus', 'Cancelling…');
}

/** Handle a progress tick from the backend (start/done/error/cancelled/finished). */
function onBatchProgress(p: ConvProgress) {
  if (p.state === 'finished') return; // summary handled by the resolved promise
  const total = p.total || batchFiles.length;
  if (p.state === 'cancelled') {
    setBatchProgress(p.index, total, p.file, fmtLabel(outFormat), 'cancelled');
    markFileRow(p.index, 'cancelled', p.file);
    setState('busy', 'Cancelling…');
    return;
  }
  if (p.state === 'start') {
    setBatchProgress(p.index - 1, total, p.file, fmtLabel(outFormat));
    markFileRow(p.index, 'run', p.file);
    setState('busy', `Converting ${p.index} / ${total}`);
  } else if (p.state === 'done') {
    setBatchProgress(p.index, total, p.file, fmtLabel(outFormat));
    markFileRow(p.index, 'done', p.file);
  } else if (p.state === 'error') {
    setBatchProgress(p.index, total, p.file, fmtLabel(outFormat));
    markFileRow(p.index, 'error', p.file, p.error);
  }
}

function setBatchProgress(done: number, total: number, file: string, fmt: string, note?: string) {
  const pct = total > 0 ? Math.max(0, Math.min(100, (done / total) * 100)) : 0;
  const fill = $opt('batchProgFill');
  if (fill) (fill as HTMLElement).style.width = pct + '%';
  setText('batchProgCount', `${done} / ${total}`);
  setText('batchProgTitle', note === 'cancelled' ? 'Cancelled' : `Converting ${Math.min(done + 1, total)} / ${total} · ${fmt}`);
  setText('batchProgSub', file ? `${file}` : '');
}

/** Pre-populate the result list with every queued file. */
function buildBatchQueue() {
  const el = $('batchFileList');
  el.innerHTML = '';
  batchFiles.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'file-row queued';
    row.id = `bfr-${i + 1}`; // 1-based to match backend progress index
    row.innerHTML =
      `<span class="fr-st">QUEUED</span>` +
      `<span class="fr-nm"></span>` +
      `<span class="fr-x">${fmtLabel(outFormat)}</span>`;
    (row.querySelector('.fr-nm') as HTMLElement).textContent = f.name;
    el.appendChild(row);
  });
}

const ROW_STATE_LABEL: Record<string, string> = { run: 'CONVERTING', done: 'DONE', error: 'ERROR', cancelled: 'CANCELLED', queued: 'QUEUED' };
function markFileRow(index: number, state: 'run' | 'done' | 'error' | 'cancelled', file: string, error?: string) {
  const row = $opt(`bfr-${index}`);
  if (!row) return;
  row.className = 'file-row ' + state;
  const st = row.querySelector('.fr-st') as HTMLElement | null;
  if (st) st.textContent = ROW_STATE_LABEL[state] || state.toUpperCase();
  const nm = row.querySelector('.fr-nm') as HTMLElement | null;
  if (nm) nm.textContent = error ? `${file} — ${error}` : file;
  row.scrollIntoView({ block: 'nearest' });
}

function finishBatch(r: BatchSummary) {
  batchRunning = false;
  setBatchControlsRunning(false);
  refreshWizard();
  const processed = r.done + r.failed;
  const fill = $opt('batchProgFill');
  const pct = r.canceled ? (r.total > 0 ? (processed / r.total) * 100 : 0) : 100;
  if (fill) (fill as HTMLElement).style.width = pct + '%';
  setText('batchProgCount', `${processed} / ${r.total}`);
  if (r.canceled) {
    setText('batchProgTitle', 'Cancelled');
    setText('batchProgSub', `${r.done} converted · ${r.failed} failed · cancelled`);
    setStatus('batchStatus', `Cancelled — ${r.done} of ${r.total} converted.`, '');
    setState('idle', 'Cancelled');
    // Any file that never started shows as cancelled rather than stuck on QUEUED.
    for (let i = processed + 1; i <= batchFiles.length; i++) {
      const f = batchFiles[i - 1];
      if (f) markFileRow(i, 'cancelled', f.name);
    }
  } else if (r.failed > 0) {
    setText('batchProgTitle', 'Finished with errors');
    setText('batchProgSub', `${r.done} converted · ${r.failed} failed`);
    setStatus('batchStatus', `Done — ${r.done} converted, ${r.failed} failed → ${batchOutDir}`, r.done ? '' : 'err');
    setState(r.done ? 'ok' : 'err', `${r.done}/${r.total} done`);
  } else {
    setText('batchProgTitle', 'Finished');
    setText('batchProgSub', `${r.done} converted → ${batchOutDir}`);
    setStatus('batchStatus', `✓ Converted ${r.done} file${r.done === 1 ? '' : 's'} → ${batchOutDir}`, 'ok');
    setState('ok', `${r.done}/${r.total} done`);
  }
  // Reconcile rows against the authoritative summary (covers any missed ticks).
  r.results.forEach((res, i) => {
    if (res.ok) markFileRow(i + 1, 'done', res.name);
    else markFileRow(i + 1, 'error', res.name, res.error);
  });
}

function setBatchControlsRunning(running: boolean) {
  $opt('cancelBatchBtn')?.classList.toggle('hidden', !running);
  for (const id of ['pickFolderBtn', 'pickOutBtn', 'runBatchBtn', 'clearBatchBtn', 'modeSingle', 'modeBatch']) {
    const b = $opt(id) as HTMLButtonElement | null;
    if (b) b.disabled = running;
  }
  // format chips disabled while running
  for (const groupId of ['fmtChipsBatch', 'fmtChips']) {
    const g = $opt(groupId);
    if (g) for (const b of g.querySelectorAll('button')) (b as HTMLButtonElement).disabled = running;
  }
}

// ── Clear (reset worker + renderer) ──
async function clearConverter() {
  if (batchRunning) return;
  try { await api.resetState(); } catch { /* best-effort */ }
  // renderer state
  summary = null;
  lastTrace = null;
  lastSection = null;
  secView.init = false; // forget the data-zoom window so the next file opens fitted
  traceIndex = 0;
  // batch state
  batchFiles = [];
  batchDir = '';
  batchOutDir = '';
  // single-file panels back to empty
  renderInfo();                 // hides fileInfo + clears summary/QC/strip
  setStatus('convStatus', '');
  showSingleProgress(false);
  ($('convertBtn') as HTMLButtonElement).disabled = true;
  // single-file wizard back to step 1
  $opt('singleFound')?.classList.toggle('hidden', true);
  setText('wizFileSub', 'SEG-Y · SEG-D · SEG-2 / .dat (Geode) · SU — parsed off the UI thread, so big files stay responsive.');
  refreshSingleWizard();
  // batch UI back to empty
  $opt('batchFound')?.classList.toggle('hidden', true);
  $opt('batchProg')?.classList.toggle('hidden', true);
  $('batchFileList').innerHTML = '';
  setStatus('batchStatus', '');
  setText('batchProgSub', '');
  setText('wizFolderSub', 'Pick a folder; SeisConv lists every .segy/.sgy/.segd/.seg/.seg2/.dat/.bat/.su file in it.');
  setText('wizDestSub', 'Where the converted files are written.');
  const fill = $opt('batchProgFill');
  if (fill) (fill as HTMLElement).style.width = '0%';
  refreshWizard();
  updateNamePreview();
  setState('idle', 'Cleared');
  // labels back on the empty Trace / Section views
  setText('traceLabel', 'Open a file to inspect traces');
  setText('secLabel', 'Open a file to view the section');
  updateFileNav();       // disable Prev/Next + clear the 'file X / N' label
  renderTraceHeader();   // clear the trace-header table (lastTrace is now null)
}

// ── Trace Inspector ──
async function refreshTrace() {
  if (!summary || summary.traceCount === 0) return;
  traceIndex = Math.max(0, Math.min(summary.traceCount - 1, traceIndex));
  try {
    lastTrace = await api.getTrace(traceIndex);
    traceFit(lastTrace); // reset the time-axis zoom window to the whole trace
    ($('traceSlider') as HTMLInputElement).max = String(summary.traceCount - 1);
    ($('traceSlider') as HTMLInputElement).value = String(traceIndex);
    renderTrace();
  } catch (e) {
    $('traceLabel').textContent = 'Trace read failed: ' + errMsg(e);
  }
}

// ── Trace-header table ───────────────────────────────────────────────────────
// Live, grouped key/value view of the per-trace SEG-Y header the worker already
// returns on `lastTrace.hdr`. Field keys below MUST match the names populated by
// the SEG-Y parser (core/formats/segy.ts) — anything absent is simply skipped.

type HdrFmt = 'int' | 'raw' | 'scaled' | 'gain' | 'mute' | 'traceId';
type HdrField = { key: string; label: string; fmt?: HdrFmt };
type HdrGroup = { title: string; fields: HdrField[] };

// SEG-Y data-use & trace-id enumerations, decoded to readable text.
const TRACE_ID_LABEL: Record<number, string> = {
  1: 'seismic', 2: 'dead', 3: 'dummy', 4: 'time-break', 5: 'uphole', 6: 'sweep',
  7: 'timing', 8: 'water-break', 9: 'near-gun', 11: 'pressure', 12: 'vert-vel',
};

const HDR_GROUPS: HdrGroup[] = [
  {
    title: 'Identification',
    fields: [
      { key: 'fieldRec', label: 'Field record (FFID)' },
      { key: 'trcField', label: 'Channel / trace no.' },
      { key: 'srcPt', label: 'Shotpoint' },
      { key: 'ensemble', label: 'Ensemble / CDP' },
      { key: 'trcEns', label: 'Trace in ensemble' },
      { key: 'seqLine', label: 'Seq. no. in line' },
      { key: 'seqFile', label: 'Seq. no. in file' },
      { key: 'traceId', label: 'Trace ID', fmt: 'traceId' },
      { key: 'dataUse', label: 'Data use' },
    ],
  },
  {
    title: 'Geometry',
    fields: [
      { key: 'offset', label: 'Source–receiver offset' },
      { key: 'srcX', label: 'Source X', fmt: 'scaled' },
      { key: 'srcY', label: 'Source Y', fmt: 'scaled' },
      { key: 'rcvX', label: 'Group X', fmt: 'scaled' },
      { key: 'rcvY', label: 'Group Y', fmt: 'scaled' },
      { key: 'srcDepth', label: 'Source depth' },
      { key: 'rcvElev', label: 'Receiver elevation' },
      { key: 'surfElev', label: 'Surface elevation @ src' },
      { key: 'elevScalar', label: 'Elevation scalar', fmt: 'raw' },
      { key: 'coordScalar', label: 'Coordinate scalar', fmt: 'raw' },
      { key: 'coordUnit', label: 'Coordinate units', fmt: 'raw' },
    ],
  },
  {
    title: 'Timing',
    fields: [
      { key: 'nSamples', label: 'Samples in trace' },
      { key: 'sampInt', label: 'Sample interval (µs)' },
      { key: 'muteStart', label: 'Mute start', fmt: 'mute' },
      { key: 'muteEnd', label: 'Mute end', fmt: 'mute' },
      { key: 'year', label: 'Recording year', fmt: 'raw' },
      { key: 'day', label: 'Day of year', fmt: 'raw' },
      { key: '__time', label: 'Recording time' },
    ],
  },
  {
    title: 'Gain & filter',
    fields: [
      { key: 'gainType', label: 'Gain type', fmt: 'gain' },
      { key: 'gainConst', label: 'Gain constant (dB)' },
      { key: 'lowCut', label: 'Low-cut (Hz)' },
      { key: 'highCut', label: 'High-cut (Hz)' },
      { key: 'traceWeight', label: 'Trace weighting' },
    ],
  },
];

const GAIN_TYPE_LABEL: Record<number, string> = { 1: 'fixed', 2: 'binary', 3: 'floating' };

function hdrNum(h: Record<string, number | string>, k: string): number | null {
  const v = h[k];
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return Number(v);
  return null;
}

/** Two zero-padded digits. */
function pad2(n: number): string { return String(n).padStart(2, '0'); }

/** Format one header field → display string, or null to omit (blank/zero where it carries no meaning). */
function fmtHdrField(h: Record<string, number | string>, f: HdrField): string | null {
  // Composite recording time HH:MM:SS, built from hour/minute/second.
  if (f.key === '__time') {
    const hh = hdrNum(h, 'hour'), mm = hdrNum(h, 'minute'), ss = hdrNum(h, 'second');
    if (hh == null && mm == null && ss == null) return null;
    if (!hh && !mm && !ss) return null;
    return `${pad2(hh ?? 0)}:${pad2(mm ?? 0)}:${pad2(ss ?? 0)}`;
  }
  const v = hdrNum(h, f.key);
  if (v == null) return null;
  switch (f.fmt) {
    case 'raw': // show even zeros (scalars/units/dates are meaningful at 0)
      return grp(v);
    case 'traceId':
      return TRACE_ID_LABEL[v] ? `${v} · ${TRACE_ID_LABEL[v]}` : grp(v);
    case 'gain':
      return GAIN_TYPE_LABEL[v] ? `${v} · ${GAIN_TYPE_LABEL[v]}` : (v === 0 ? null : grp(v));
    case 'mute':
      return v === 0 ? null : `${grp(v)} ms`;
    case 'scaled': // coordinate — apply the SEG-Y coordinate scalar, but only if set
      if (v === 0) return null;
      return grp(applyCoordScalar(v, hdrNum(h, 'coordScalar')));
    default: // 'int' — omit unset (0) numeric fields to keep the table tidy
      return v === 0 ? null : grp(v);
  }
}

/** Apply the SEG-Y coordinate scalar convention: +n multiplies, −n divides. */
function applyCoordScalar(v: number, scalar: number | null): number {
  if (scalar == null || scalar === 0) return v;
  return scalar > 0 ? v * scalar : v / -scalar;
}

/** Render the active trace's SEG-Y header into the grouped table. */
function renderTraceHeader() {
  const grid = $opt('traceHdrGrid');
  const tag = $opt('traceHdrTrace');
  if (!grid) return;
  if (!summary || !lastTrace) {
    grid.innerHTML = '<div class="hdr-empty">Open a file and pick a trace to view its header.</div>';
    if (tag) tag.textContent = '—';
    return;
  }
  const h = lastTrace.hdr || {};
  if (tag) tag.textContent = `Trace ${lastTrace.index + 1} / ${summary.traceCount}`;
  grid.innerHTML = '';
  let anyField = false;
  for (const group of HDR_GROUPS) {
    const rows: { label: string; value: string }[] = [];
    for (const f of group.fields) {
      const val = fmtHdrField(h, f);
      if (val == null) continue;
      rows.push({ label: f.label, value: val });
    }
    if (!rows.length) continue;
    anyField = true;
    const sec = document.createElement('div');
    sec.className = 'hdr-grp';
    const h3 = document.createElement('h3');
    h3.textContent = group.title;
    sec.appendChild(h3);
    for (const r of rows) {
      const kv = document.createElement('div');
      kv.className = 'kv';
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = r.label;
      const v = document.createElement('span');
      v.className = 'v mono';
      v.textContent = r.value;
      kv.appendChild(k);
      kv.appendChild(v);
      sec.appendChild(kv);
    }
    grid.appendChild(sec);
  }
  if (!anyField) grid.innerHTML = '<div class="hdr-empty">This trace carries no populated header fields.</div>';
}

/** Draw the active trace in the current mode (waveform or amplitude spectrum). */
function renderTrace() {
  if (!summary || !lastTrace) return;
  const cv = $('traceCanvas') as HTMLCanvasElement;
  const t = lastTrace;
  if (traceMode === 'spectrum') {
    drawSpectrum(cv, t);
    const ny = t.sampleInt > 0 ? 1e6 / t.sampleInt / 2 : 0;
    $('traceLabel').textContent = `Trace ${t.index + 1} / ${summary.traceCount}  ·  spectrum 0–${ny.toFixed(0)} Hz`;
  } else {
    drawTrace(cv, t);
    $('traceLabel').textContent = `Trace ${t.index + 1} / ${summary.traceCount}  ·  ${t.nSamples} samples`;
  }
  // Header table tracks the active trace regardless of plot mode.
  renderTraceHeader();
}

function setTraceMode(m: 'wave' | 'spectrum') {
  if (traceMode === m) return;
  traceMode = m;
  $('traceWave').classList.toggle('on', m === 'wave');
  $('traceSpec').classList.toggle('on', m === 'spectrum');
  renderTrace();
}

function drawTrace(cv: HTMLCanvasElement, t: TraceData) {
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 800;
  const H = cv.clientHeight || 460;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0d1f33';
  ctx.fillRect(0, 0, W, H);
  const n = t.nSamples;
  if (!n || !t.samples.length) return;

  // Visible sample window [s0,s1) within the full trace (clamped to the data).
  if (!traceView.init || traceView.fullS !== n) traceFit(t);
  const s0 = traceView.s0, s1 = traceView.s1;
  const span = s1 - s0;
  if (span < 1) return;

  const ML = 60, MR = 14, MT = 14, MB = 26;
  const pw = W - ML - MR, ph = H - MT - MB;
  const cx = ML + pw / 2;
  // Renormalize over the VISIBLE window so zoom shows local detail at full swing.
  const nf = normFactorPercentile(t.samples.subarray(s0, s1), 0.95) || 1;

  ctx.strokeStyle = '#214564';
  ctx.lineWidth = 1;
  ctx.strokeRect(ML, MT, pw, ph);
  ctx.beginPath();
  ctx.moveTo(cx, MT);
  ctx.lineTo(cx, MT + ph);
  ctx.strokeStyle = '#264a68';
  ctx.stroke();

  ctx.beginPath();
  ctx.strokeStyle = '#34dbd0';
  ctx.lineWidth = 1;
  const denom = span > 1 ? span - 1 : 1; // map sample i∈[s0,s1) → y over the plot height
  for (let i = s0; i < s1; i++) {
    const v = Math.max(-1, Math.min(1, t.samples[i] / nf));
    const x = cx + v * (pw / 2 - 2);
    const y = MT + ((i - s0) / denom) * ph;
    if (i === s0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // time axis (ms down) — labels reflect the visible window [s0,s1)
  ctx.fillStyle = '#7e93ac';
  ctx.font = '10px Consolas, monospace';
  const msPerSample = t.sampleInt / 1000;
  for (let k = 0; k <= 5; k++) {
    const y = MT + (ph * k) / 5;
    const sampleAt = s0 + (denom * k) / 5;
    ctx.fillText((sampleAt * msPerSample).toFixed(0) + ' ms', 6, y + 3);
    ctx.strokeStyle = '#173049';
    ctx.beginPath();
    ctx.moveTo(ML, y);
    ctx.lineTo(ML + pw, y);
    ctx.stroke();
  }
}

/** Single-sided amplitude spectrum (amplitude vs Hz) of the active trace. */
function drawSpectrum(cv: HTMLCanvasElement, t: TraceData) {
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 800, H = cv.clientHeight || 460;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#0f2540'); bg.addColorStop(1, '#0b1a2c');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  if (!t.nSamples || !t.samples.length) return;

  const sp = amplitudeSpectrum(t.samples, t.sampleInt);
  const ML = 56, MR = 16, MT = 18, MB = 28;
  const pw = W - ML - MR, ph = H - MT - MB;
  const fmax = sp.nyquist || 1;
  let amax = 0;
  for (let k = 1; k < sp.amp.length; k++) if (sp.amp[k] > amax) amax = sp.amp[k];
  if (amax <= 0) amax = 1;
  const Xf = (f: number) => ML + (f / fmax) * pw;
  const Yf = (a: number) => { const y = MT + ph - (a / amax) * ph; return y < MT ? MT : y; };

  // frequency gridlines + labels
  ctx.font = '10px Consolas, monospace'; ctx.lineWidth = 1;
  const fStep = niceStep(fmax, 8);
  for (let f = 0; f <= fmax + 1e-6; f += fStep) {
    const x = Xf(f); if (x > W - MR + 1) break;
    ctx.strokeStyle = 'rgba(33,69,100,0.45)';
    ctx.beginPath(); ctx.moveTo(x, MT); ctx.lineTo(x, MT + ph); ctx.stroke();
    ctx.fillStyle = '#5e7186'; ctx.fillText(f.toFixed(0), x + 2, H - 8);
  }
  // amplitude gridlines + labels
  for (let g = 0; g <= 4; g++) {
    const y = MT + (ph * g) / 4;
    ctx.strokeStyle = 'rgba(33,69,100,0.45)';
    ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(ML + pw, y); ctx.stroke();
    ctx.fillStyle = '#5e7186'; ctx.fillText(((amax * (4 - g)) / 4).toPrecision(2), 4, y + 3);
  }

  // filled spectrum curve
  ctx.beginPath();
  ctx.moveTo(Xf(0), Yf(0));
  for (let k = 0; k < sp.amp.length; k++) ctx.lineTo(Xf(sp.freqs[k]), Yf(sp.amp[k]));
  ctx.lineTo(Xf(sp.freqs[sp.freqs.length - 1]), Yf(0));
  ctx.closePath();
  const fill = ctx.createLinearGradient(0, MT, 0, MT + ph);
  fill.addColorStop(0, 'rgba(52,219,208,0.42)'); fill.addColorStop(1, 'rgba(52,219,208,0.04)');
  ctx.fillStyle = fill; ctx.fill();
  ctx.strokeStyle = '#34dbd0'; ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (let k = 0; k < sp.amp.length; k++) {
    const x = Xf(sp.freqs[k]), y = Yf(sp.amp[k]);
    if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // peak marker
  let pk = 1;
  for (let k = 2; k < sp.amp.length; k++) if (sp.amp[k] > sp.amp[pk]) pk = k;
  const pkx = Xf(sp.freqs[pk]), pky = Yf(sp.amp[pk]);
  ctx.fillStyle = '#1fc8c0'; ctx.beginPath(); ctx.arc(pkx, pky, 3, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#c8d2e0'; ctx.font = '11px "Segoe UI", sans-serif';
  ctx.fillText(`peak ${sp.freqs[pk].toFixed(1)} Hz`, Math.min(pkx + 6, W - 84), Math.max(pky - 6, MT + 12));

  // axis title
  ctx.fillStyle = '#7e93ac'; ctx.font = '10px Consolas, monospace';
  ctx.fillText('Frequency (Hz) →', ML, MT - 6);
}

// ── File Viewer (section) ──
// Plot-rectangle margins (shared by drawSection + the data-zoom interactions so
// a cursor pixel maps to the exact same data window the renderer paints).
const SEC_ML = 58, SEC_MR = 12, SEC_MT = 10, SEC_MB = 24;

/** Reset the data-zoom window to the whole record (called on open / AGC change / fit). */
function secFit() {
  if (!summary) return;
  secView.fullT = summary.traceCount;
  secView.fullS = summary.samplesTrace ?? lastSection?.fullSamples ?? 0;
  secView.t0 = 0;
  secView.t1 = secView.fullT;
  secView.s0 = 0;
  secView.s1 = secView.fullS;
  secView.init = true;
}

/** Keep the visible window inside the record (never pan/zoom off the data). */
function secClamp() {
  const fT = secView.fullT, fS = secView.fullS;
  // Minimum window: a few traces / samples so we can't zoom into nothing.
  const minT = Math.min(fT, 2), minS = Math.min(fS, 4);
  let { t0, t1, s0, s1 } = secView;
  if (t1 - t0 < minT) t1 = t0 + minT;
  if (s1 - s0 < minS) s1 = s0 + minS;
  if (t1 - t0 > fT) { t0 = 0; t1 = fT; }
  if (s1 - s0 > fS) { s0 = 0; s1 = fS; }
  if (t0 < 0) { t1 -= t0; t0 = 0; }
  if (t1 > fT) { t0 -= t1 - fT; t1 = fT; }
  if (s0 < 0) { s1 -= s0; s0 = 0; }
  if (s1 > fS) { s0 -= s1 - fS; s1 = fS; }
  secView.t0 = Math.max(0, Math.round(t0));
  secView.t1 = Math.min(fT, Math.round(t1));
  secView.s0 = Math.max(0, Math.round(s0));
  secView.s1 = Math.min(fS, Math.round(s1));
}

/** Re-request the current visible window at full detail and repaint. Coalesces
 *  bursts of wheel/drag events so the worker is never flooded. */
async function fetchSectionWindow() {
  if (!summary || summary.traceCount === 0) return;
  if (secFetchPending) return; // a fetch is in flight; it will repaint with the latest secView on completion
  secFetchPending = true;
  const agc = ($('secAgc') as HTMLInputElement).checked;
  try {
    let again = true;
    let snap = '';
    while (again) {
      secClamp();
      snap = `${secView.t0},${secView.t1},${secView.s0},${secView.s1}`;
      const sec = await api.getSection({
        maxTraces: 2000, maxSamples: 2000,
        traceStart: secView.t0, traceEnd: secView.t1, sampStart: secView.s0, sampEnd: secView.s1,
        agc, agcType: 'rms', agcWindowMs: 250,
      });
      lastSection = sec;
      // Worker echoes the window it actually used (clamped to real trace lengths);
      // mirror it so axis labels + interactions stay perfectly in sync.
      secView.t0 = sec.traceStart; secView.t1 = sec.traceEnd;
      secView.s0 = sec.sampStart; secView.s1 = sec.sampEnd;
      secView.fullT = sec.fullTraces; secView.fullS = sec.fullSamples;
      drawSection($('secCanvas') as HTMLCanvasElement, sec);
      const zoomed = sec.traceStart > 0 || sec.traceEnd < sec.fullTraces || sec.sampStart > 0 || sec.sampEnd < sec.fullSamples;
      $('secLabel').textContent =
        `${sec.numTraces} traces (step ${sec.traceStep}) · ${sec.colLen} samples` +
        (zoomed ? ` · tr ${sec.traceStart}–${sec.traceEnd} · smp ${sec.sampStart}–${sec.sampEnd}` : '');
      // If the user kept interacting while we awaited, secView changed — fetch again.
      again = `${secView.t0},${secView.t1},${secView.s0},${secView.s1}` !== snap;
    }
  } catch (e) {
    $('secLabel').textContent = 'Render failed: ' + errMsg(e);
  } finally {
    secFetchPending = false;
  }
}

async function refreshSection() {
  if (!summary || summary.traceCount === 0) return;
  $('secLabel').textContent = 'Rendering…';
  secFit(); // open / AGC toggle / re-open ⇒ start fitted to the whole record
  await fetchSectionWindow();
}

function redrawSection() {
  if (lastSection) drawSection($('secCanvas') as HTMLCanvasElement, lastSection);
}

function drawSection(cv: HTMLCanvasElement, sec: SectionData) {
  const mode = ($('secMode') as HTMLSelectElement).value;
  const cmap = ($('secColor') as HTMLSelectElement).value;
  const gain = parseFloat(($('secGain') as HTMLInputElement).value) || 1;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 900;
  const H = cv.clientHeight || 500;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0d1f33';
  ctx.fillRect(0, 0, W, H);

  const { numTraces, colLen, norm, data } = sec;
  if (!numTraces || !colLen) return;
  const ML = SEC_ML, MR = SEC_MR, MT = SEC_MT, MB = SEC_MB;
  const pw = W - ML - MR;
  const ph = H - MT - MB;
  const g = gain / (norm || 1);

  if (mode === 'vd' || mode === 'vdwig') {
    const off = document.createElement('canvas');
    off.width = numTraces;
    off.height = colLen;
    const octx = off.getContext('2d')!;
    const img = octx.createImageData(numTraces, colLen);
    for (let t = 0; t < numTraces; t++) {
      const base = t * colLen;
      for (let s = 0; s < colLen; s++) {
        const v = Math.max(-1, Math.min(1, data[base + s] * g));
        const [r, gg, b] = getColor(v, cmap);
        const idx = (s * numTraces + t) * 4;
        img.data[idx] = r;
        img.data[idx + 1] = gg;
        img.data[idx + 2] = b;
        img.data[idx + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, ML, MT, pw, ph);
  }

  if (mode === 'wiggle' || mode === 'va' || mode === 'vdwig') {
    const tw = pw / numTraces;
    const wsc = Math.max(tw * 0.48, 1);
    for (let t = 0; t < numTraces; t++) {
      const base = t * colLen;
      const x0 = ML + (t + 0.5) * tw;
      if (mode === 'va') {
        ctx.beginPath();
        ctx.moveTo(x0, MT);
        for (let s = 0; s < colLen; s++) {
          const v = Math.max(0, Math.min(1, data[base + s] * g));
          ctx.lineTo(x0 + v * wsc, MT + (s / (colLen - 1)) * ph);
        }
        ctx.lineTo(x0, MT + ph);
        ctx.closePath();
        ctx.fillStyle = '#1fc8c0';
        ctx.fill();
      } else {
        ctx.beginPath();
        for (let s = 0; s < colLen; s++) {
          const v = Math.max(-1, Math.min(1, data[base + s] * g));
          const x = x0 + v * wsc;
          const y = MT + (s / (colLen - 1)) * ph;
          if (s === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = mode === 'vdwig' ? 'rgba(13,31,51,0.8)' : '#34dbd0';
        ctx.lineWidth = 0.7;
        ctx.stroke();
      }
    }
  }

  // Axes reflect the VISIBLE data-zoom window (worker echoes it on `sec`):
  //   time  ← sample window [sampStart, sampEnd) × sampleInt
  //   trace ← trace  window [traceStart, traceEnd)
  ctx.fillStyle = '#7e93ac';
  ctx.font = '10px Consolas, monospace';
  const siUs = summary?.sampleInt ?? sec.sampleInt; // µs/sample
  const t0ms = (sec.sampStart * siUs) / 1000;
  const t1ms = (sec.sampEnd * siUs) / 1000;
  ctx.textAlign = 'left';
  for (let k = 0; k <= 5; k++) {
    const y = MT + (ph * k) / 5;
    const ms = t0ms + ((t1ms - t0ms) * k) / 5;
    ctx.fillText(ms.toFixed(0) + ' ms', 6, y + 3);
  }
  // Trace-index axis along the bottom edge of the plot.
  ctx.textAlign = 'center';
  const tr0 = sec.traceStart, tr1 = sec.traceEnd;
  for (let k = 0; k <= 5; k++) {
    const x = ML + (pw * k) / 5;
    const tr = Math.round(tr0 + ((tr1 - tr0) * k) / 5);
    ctx.fillText('#' + tr, Math.max(ML + 10, Math.min(W - MR - 10, x)), H - 4);
  }
  ctx.textAlign = 'left';
}

// ── Section data-zoom / pan (mirrors the SPS survey-grid interaction) ──
// Distinct from the app-wide UI zoom: this zooms into the seismic DATA by
// re-fetching the visible [t0,t1)×[s0,s1) window at full detail.

/** Map a cursor pixel inside the section canvas to a fractional position in the
 *  plot rectangle (0..1 along trace-x and sample-y), clamped to the data area. */
function secPlotFrac(cv: HTMLCanvasElement, e: MouseEvent): { fx: number; fy: number } {
  const r = cv.getBoundingClientRect();
  const W = cv.clientWidth || 900, H = cv.clientHeight || 500;
  const pw = W - SEC_ML - SEC_MR, ph = H - SEC_MT - SEC_MB;
  const px = e.clientX - r.left - SEC_ML, py = e.clientY - r.top - SEC_MT;
  return { fx: Math.max(0, Math.min(1, px / pw)), fy: Math.max(0, Math.min(1, py / ph)) };
}

/** Zoom the visible window toward the cursor by `factor` (<1 zooms in). */
function secZoomAt(fx: number, fy: number, factor: number) {
  if (!secView.init) secFit();
  // Data index under the cursor (anchor point that stays put).
  const at = secView.t0 + fx * (secView.t1 - secView.t0);
  const as = secView.s0 + fy * (secView.s1 - secView.s0);
  const wt = (secView.t1 - secView.t0) * factor;
  const ws = (secView.s1 - secView.s0) * factor;
  secView.t0 = at - fx * wt; secView.t1 = at + (1 - fx) * wt;
  secView.s0 = as - fy * ws; secView.s1 = as + (1 - fy) * ws;
}

/** Zoom both axes toward the canvas centre (toolbar +/- buttons). */
function secZoomButton(factor: number) {
  if (!summary || summary.traceCount === 0) return;
  secZoomAt(0.5, 0.5, factor);
  void fetchSectionWindow();
}

/** Map a (non-drag) click on the section canvas to an absolute trace index in the
 *  open file and send that trace to the Trace Workbench. Reuses the shared add
 *  path (wbAddTrace) so the new trace lands in the same wbTraces the Workbench
 *  tab renders/analyses/exports. Does NOT switch tabs. */
async function secAddTraceFromClick(cv: HTMLCanvasElement, e: MouseEvent) {
  if (!summary || summary.traceCount === 0) return;
  const { fx } = secPlotFrac(cv, e);
  // Fractional x across the visible window → absolute trace index in the file.
  const idx = Math.round(secView.t0 + fx * (secView.t1 - secView.t0));
  const index = Math.max(0, Math.min(summary.traceCount - 1, idx));
  try {
    $('secLabel').textContent = `Adding trace ${index + 1} to Workbench…`;
    const tr = await api.getTrace(index); // the open file is the active 'current' file
    wbAddTrace(`${summary.name} #${index + 1}`, index, tr.samples.slice(), tr.sampleInt, tr.nSamples);
    $('secLabel').textContent = `Added trace ${index + 1} to Workbench`;
  } catch (err) {
    $('secLabel').textContent = 'Add to Workbench failed: ' + errMsg(err);
  }
}

/** Attach wheel-zoom / drag-pan / double-click-fit / click-to-add to the section canvas (once). */
function sectionInteractions() {
  const cv = $('secCanvas') as HTMLCanvasElement;
  let dragging = false, lx = 0, ly = 0;
  // Click-vs-drag guard (mirrors the SPS grid canvas): a click that moved the
  // cursor more than a few pixels is treated as a pan, not an add.
  let downX = 0, downY = 0, moved = 0;
  cv.addEventListener('wheel', (e) => {
    if ($('panel-section').style.display === 'none' || !summary || summary.traceCount === 0) return;
    e.preventDefault();
    const { fx, fy } = secPlotFrac(cv, e);
    secZoomAt(fx, fy, e.deltaY < 0 ? 1 / 1.15 : 1.15);
    void fetchSectionWindow();
  }, { passive: false });
  cv.addEventListener('mousedown', (e) => {
    if ($('panel-section').style.display === 'none' || !summary) return;
    dragging = true; lx = e.clientX; ly = e.clientY;
    downX = e.clientX; downY = e.clientY; moved = 0;
    cv.style.cursor = 'grabbing';
  });
  window.addEventListener('mouseup', () => { dragging = false; cv.style.cursor = ''; });
  cv.addEventListener('mousemove', (e) => {
    if (!dragging || !secView.init) return;
    moved += Math.abs(e.clientX - lx) + Math.abs(e.clientY - ly);
    const W = cv.clientWidth || 900, H = cv.clientHeight || 500;
    const pw = W - SEC_ML - SEC_MR, ph = H - SEC_MT - SEC_MB;
    // Pixel drag → index drag (drag right ⇒ window moves left, like grabbing the image).
    const dt = ((e.clientX - lx) / pw) * (secView.t1 - secView.t0);
    const ds = ((e.clientY - ly) / ph) * (secView.s1 - secView.s0);
    secView.t0 -= dt; secView.t1 -= dt;
    secView.s0 -= ds; secView.s1 -= ds;
    lx = e.clientX; ly = e.clientY;
    void fetchSectionWindow();
  });
  // A click (press + release without a real drag) adds the trace under the cursor
  // when the "+ Workbench" toggle is active; otherwise it behaves as today (no-op).
  cv.addEventListener('click', (e) => {
    if ($('panel-section').style.display === 'none' || !summary || summary.traceCount === 0) return;
    if (!secToWb) return;
    if (moved > 4 || Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 4) return; // a pan, not a click
    void secAddTraceFromClick(cv, e);
  });
  cv.addEventListener('dblclick', () => {
    if ($('panel-section').style.display === 'none' || !summary) return;
    secFit(); void fetchSectionWindow();
  });
  // Toolbar buttons (added in index.html alongside the section controls).
  $opt('secZoomIn')?.addEventListener('click', () => secZoomButton(1 / 1.4));
  $opt('secZoomOut')?.addEventListener('click', () => secZoomButton(1.4));
  $opt('secZoomFit')?.addEventListener('click', () => { secFit(); void fetchSectionWindow(); });
  // "+ Workbench" toggle: arm/disarm click-to-add on the section canvas.
  const wbToggle = $opt('secToWb') as HTMLButtonElement | null;
  wbToggle?.addEventListener('click', () => {
    secToWb = !secToWb;
    wbToggle.classList.toggle('on', secToWb);
    wbToggle.textContent = secToWb ? 'Send to Workbench' : '+ Workbench';
    cv.style.cursor = secToWb ? 'copy' : '';
    $('secLabel').textContent = secToWb ? 'Click a trace to add it to the Workbench' : '';
  });
}

// ── Trace Inspector time-axis zoom / pan (renderer-only) ──
// The full trace is already in lastTrace.samples, so zoom/pan just re-windows
// [s0,s1) and repaints — no worker round-trip. Mirrors the section interactions.

/** Reset the visible window to the whole trace ("fit"). */
function traceFit(t: TraceData) {
  traceView.fullS = t.nSamples;
  traceView.s0 = 0;
  traceView.s1 = t.nSamples;
  traceView.init = true;
}

/** Keep the visible window inside the trace (never pan/zoom off the data). */
function traceClamp() {
  const fS = traceView.fullS;
  const minS = Math.min(fS, 4); // can't zoom into fewer than a few samples
  let { s0, s1 } = traceView;
  if (s1 - s0 < minS) s1 = s0 + minS;
  if (s1 - s0 > fS) { s0 = 0; s1 = fS; }
  if (s0 < 0) { s1 -= s0; s0 = 0; }
  if (s1 > fS) { s0 -= s1 - fS; s1 = fS; }
  traceView.s0 = Math.max(0, Math.round(s0));
  traceView.s1 = Math.min(fS, Math.round(s1));
}

/** Map a cursor pixel inside the trace canvas to a fractional position (0..1)
 *  down the plot rectangle (the time axis), clamped to the data area. */
function tracePlotFrac(cv: HTMLCanvasElement, e: MouseEvent): number {
  const r = cv.getBoundingClientRect();
  const H = cv.clientHeight || 460;
  const MT = 14, MB = 26, ph = H - MT - MB;
  const py = e.clientY - r.top - MT;
  return ph > 0 ? Math.max(0, Math.min(1, py / ph)) : 0;
}

/** Zoom the visible sample window toward a fractional anchor `fy` by `factor`
 *  (<1 zooms in). The sample under the cursor stays put. */
function traceZoomAt(fy: number, factor: number) {
  if (!lastTrace) return;
  if (!traceView.init || traceView.fullS !== lastTrace.nSamples) traceFit(lastTrace);
  const as = traceView.s0 + fy * (traceView.s1 - traceView.s0); // anchor sample
  const ws = (traceView.s1 - traceView.s0) * factor;
  traceView.s0 = as - fy * ws;
  traceView.s1 = as + (1 - fy) * ws;
  traceClamp();
}

/** Zoom toward the canvas centre (toolbar +/- buttons), then repaint. */
function traceZoomButton(factor: number) {
  if (!lastTrace || traceMode !== 'wave') return;
  traceZoomAt(0.5, factor);
  renderTrace();
}

/** Attach wheel-zoom / drag-pan / double-click-fit to the trace canvas (once).
 *  Guarded on the trace panel being visible and a waveform being shown. */
function traceInteractions() {
  const cv = $('traceCanvas') as HTMLCanvasElement;
  const active = () =>
    $('panel-trace').style.display !== 'none' && !!lastTrace && traceMode === 'wave';
  let dragging = false, ly = 0;
  cv.addEventListener('wheel', (e) => {
    if (!active()) return;
    e.preventDefault();
    const fy = tracePlotFrac(cv, e);
    traceZoomAt(fy, e.deltaY < 0 ? 1 / 1.15 : 1.15); // wheel up ⇒ zoom in
    renderTrace();
  }, { passive: false });
  cv.addEventListener('mousedown', (e) => {
    if (!active()) return;
    dragging = true; ly = e.clientY; cv.style.cursor = 'grabbing';
  });
  window.addEventListener('mouseup', () => { dragging = false; cv.style.cursor = ''; });
  cv.addEventListener('mousemove', (e) => {
    if (!dragging || !traceView.init || !active()) return;
    const H = cv.clientHeight || 460;
    const MT = 14, MB = 26, ph = H - MT - MB;
    if (ph <= 0) return;
    // Pixel drag → sample drag (drag down ⇒ window moves up, like grabbing the trace).
    const ds = ((e.clientY - ly) / ph) * (traceView.s1 - traceView.s0);
    traceView.s0 -= ds; traceView.s1 -= ds;
    traceClamp();
    ly = e.clientY;
    renderTrace();
  });
  cv.addEventListener('dblclick', () => {
    if (!active()) return;
    traceFit(lastTrace!); renderTrace();
  });
  // Toolbar buttons (added in index.html alongside the Waveform/Spectrum toggle).
  $opt('traceZoomIn')?.addEventListener('click', () => traceZoomButton(1 / 1.4));
  $opt('traceZoomOut')?.addEventListener('click', () => traceZoomButton(1.4));
  $opt('traceZoomFit')?.addEventListener('click', () => {
    if (lastTrace) { traceFit(lastTrace); renderTrace(); }
  });
}

// ── Trace Workbench ──
// Collect individual traces from arbitrary files (or the currently-open file)
// and compare them side-by-side or overlaid, all zoomed/panned together on one
// shared time axis. Wiggle drawing reuses drawTrace's centre-axis mapping; the
// shared wbView mirrors the inspector's traceView so the interactions match.

/** Longest trace in the collection (samples), or 0 when empty — the time extent. */
function wbMaxSamples(): number {
  let m = 0;
  for (const t of wbTraces) if (t.nSamples > m) m = t.nSamples;
  return m;
}

/** Reset the shared time window to the full extent ("fit"). */
function wbFit() {
  const full = wbMaxSamples();
  wbView.fullS = full;
  wbView.s0 = 0;
  wbView.s1 = full;
  wbView.init = true;
}

/** Keep the shared window inside the data (never pan/zoom off the longest trace). */
function wbClamp() {
  const fS = wbView.fullS;
  const minS = Math.min(fS, 4);
  let { s0, s1 } = wbView;
  if (s1 - s0 < minS) s1 = s0 + minS;
  if (s1 - s0 > fS) { s0 = 0; s1 = fS; }
  if (s0 < 0) { s1 -= s0; s0 = 0; }
  if (s1 > fS) { s0 -= s1 - fS; s1 = fS; }
  wbView.s0 = Math.max(0, Math.round(s0));
  wbView.s1 = Math.min(fS, Math.round(s1));
}

/** Cursor pixel → fractional position (0..1) down the plot's time axis. */
function wbPlotFrac(cv: HTMLCanvasElement, e: MouseEvent): number {
  const r = cv.getBoundingClientRect();
  const H = cv.clientHeight || 460;
  const MT = 14, MB = 26, ph = H - MT - MB;
  const py = e.clientY - r.top - MT;
  return ph > 0 ? Math.max(0, Math.min(1, py / ph)) : 0;
}

/** Zoom the shared window toward fractional anchor `fy` by `factor` (<1 zooms in). */
function wbZoomAt(fy: number, factor: number) {
  if (!wbTraces.length) return;
  if (!wbView.init || wbView.fullS !== wbMaxSamples()) wbFit();
  const as = wbView.s0 + fy * (wbView.s1 - wbView.s0);
  const ws = (wbView.s1 - wbView.s0) * factor;
  wbView.s0 = as - fy * ws;
  wbView.s1 = as + (1 - fy) * ws;
  wbClamp();
}

/** Zoom toward the canvas centre (toolbar +/- buttons), then repaint. */
function wbZoomButton(factor: number) {
  if (!wbTraces.length) return;
  wbZoomAt(0.5, factor);
  drawWorkbench();
}

/** Pick a file (no parse), then add the chosen trace # to the collection. */
async function wbPickAndAdd() {
  try {
    const path = await api.pickTraceFile();
    if (!path) return;
    const idxIn = $opt('wbIndex') as HTMLInputElement | null;
    const index = Math.max(0, (parseInt(idxIn?.value || '0', 10) || 0));
    setStatus('wbStatus', 'Reading trace…');
    const tr = await api.extractTrace(path, index);
    wbAddTrace(tr.name, tr.index, tr.samples, tr.sampleInt, tr.nSamples);
    setStatus('wbStatus', `Added ${tr.name} · trace ${tr.index + 1} (of ${tr.traceCount})`, 'ok');
  } catch (e) {
    setStatus('wbStatus', 'Add failed: ' + errMsg(e), 'err');
  }
}

/** Add the currently-open file's current trace (Trace Inspector selection). */
function wbAddOpenTrace() {
  if (!summary || !lastTrace) {
    setStatus('wbStatus', 'Open a file and pick a trace first.', 'err');
    return;
  }
  wbAddTrace(summary.name, lastTrace.index, lastTrace.samples.slice(), lastTrace.sampleInt, lastTrace.nSamples);
  setStatus('wbStatus', `Added open file · trace ${lastTrace.index + 1}`, 'ok');
}

/** Push one trace into the collection (distinct colour), refit + redraw. */
function wbAddTrace(sourceName: string, traceIndex: number, samples: Float32Array, sampleInt: number, nSamples: number) {
  const color = WB_COLORS[(wbNextId - 1) % WB_COLORS.length];
  wbTraces.push({ id: wbNextId++, sourceName, traceIndex, samples, sampleInt, nSamples, color });
  wbFit(); // new extent ⇒ refit the shared window so the addition is visible
  renderWorkbenchList();
  drawWorkbench();
  wbUpdateAnalysis();
  wbUpdateExport();
}

/** Remove one trace by id; refit + redraw (clears the view when empty). */
function wbRemove(id: number) {
  wbTraces = wbTraces.filter((t) => t.id !== id);
  wbFit();
  renderWorkbenchList();
  drawWorkbench();
  wbUpdateAnalysis();
  wbUpdateExport();
}

/** Drop the whole collection. */
function wbClear() {
  wbTraces = [];
  wbView.init = false;
  wbSelA = -1;
  wbSelB = -1;
  renderWorkbenchList();
  drawWorkbench();
  wbUpdateAnalysis();
  wbUpdateExport();
  setStatus('wbExportStatus', '');
  setStatus('wbStatus', '');
}

/** Switch the display mode (side-by-side vs overlay) + repaint. */
function wbSetMode(m: 'side' | 'overlay') {
  if (wbMode === m) return;
  wbMode = m;
  $opt('wbModeSide')?.classList.toggle('on', m === 'side');
  $opt('wbModeOverlay')?.classList.toggle('on', m === 'overlay');
  drawWorkbench();
}

/** Render the collected-trace list (source · trace # · colour swatch + remove). */
function renderWorkbenchList() {
  const list = $opt('wbList');
  if (!list) return;
  if (!wbTraces.length) {
    list.innerHTML = '<div class="hdr-empty">No traces collected yet.</div>';
    return;
  }
  list.innerHTML = '';
  for (const t of wbTraces) {
    const row = document.createElement('div');
    row.className = 'wb-item';
    const sw = document.createElement('span');
    sw.className = 'wb-swatch';
    sw.style.background = t.color;
    const lbl = document.createElement('span');
    lbl.className = 'wb-item-lbl';
    lbl.textContent = `${t.sourceName} · trace ${t.traceIndex + 1}`;
    const rm = document.createElement('button');
    rm.className = 'wb-rm';
    rm.title = 'Remove';
    rm.textContent = '✕';
    rm.addEventListener('click', () => wbRemove(t.id));
    row.append(sw, lbl, rm);
    list.appendChild(row);
  }
}

/** Draw one trace's wiggle in a vertical band centred at `cx`, half-width `hw`,
 *  over the shared time window [s0,s1) — reuses drawTrace's centre-axis mapping.
 *  `nf` is the normalization factor (per-trace in side mode, shared in overlay). */
function wbDrawWiggle(ctx: CanvasRenderingContext2D, t: WbTrace, cx: number, hw: number, MT: number, ph: number, s0: number, s1: number, nf: number, color: string) {
  const span = s1 - s0;
  if (span < 1) return;
  const denom = span > 1 ? span - 1 : 1;
  const lo = Math.max(0, s0), hi = Math.min(t.nSamples, s1);
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  let started = false;
  for (let i = lo; i < hi; i++) {
    const v = Math.max(-1, Math.min(1, t.samples[i] / nf));
    const x = cx + v * (hw - 2);
    const y = MT + ((i - s0) / denom) * ph;
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

/** Paint the workbench canvas: empty placeholder, side-by-side columns, or a
 *  shared-axis overlay. Time mapping + zoom window are shared across all traces
 *  so they stay aligned; a small legend labels each colour. */
function drawWorkbench() {
  const cv = $opt('wbCanvas') as HTMLCanvasElement | null;
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 800;
  const H = cv.clientHeight || 460;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0d1f33';
  ctx.fillRect(0, 0, W, H);

  if (!wbTraces.length) {
    ctx.fillStyle = '#5e7186';
    ctx.font = '13px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Pick traces to compare', W / 2, H / 2);
    ctx.textAlign = 'left';
    return;
  }

  if (!wbView.init || wbView.fullS !== wbMaxSamples()) wbFit();
  const s0 = wbView.s0, s1 = wbView.s1;
  if (s1 - s0 < 1) return;

  const ML = 60, MR = 14, MT = 14, MB = 26;
  const pw = W - ML - MR, ph = H - MT - MB;

  ctx.strokeStyle = '#214564';
  ctx.lineWidth = 1;
  ctx.strokeRect(ML, MT, pw, ph);

  // Time axis (ms down) — labelled from the longest trace's sample interval, or
  // the first trace's if they differ. Mapping is the SAME for every trace so the
  // side-by-side columns and the overlay all line up in time.
  const si = wbTraces[0].sampleInt || 0;
  const denom = s1 - s0 > 1 ? s1 - s0 - 1 : 1;
  ctx.fillStyle = '#7e93ac';
  ctx.font = '10px Consolas, monospace';
  const msPerSample = si / 1000;
  for (let k = 0; k <= 5; k++) {
    const y = MT + (ph * k) / 5;
    const sampleAt = s0 + (denom * k) / 5;
    ctx.fillText((sampleAt * msPerSample).toFixed(0) + ' ms', 6, y + 3);
    ctx.strokeStyle = '#173049';
    ctx.beginPath();
    ctx.moveTo(ML, y);
    ctx.lineTo(ML + pw, y);
    ctx.stroke();
  }

  if (wbMode === 'side') {
    // Split the plot width into N equal columns; each trace's wiggle is centred
    // in its column and normalized over its OWN visible window (independent gain).
    const n = wbTraces.length;
    const colW = pw / n;
    for (let j = 0; j < n; j++) {
      const t = wbTraces[j];
      const cx = ML + colW * (j + 0.5);
      const hw = colW / 2;
      // column divider + faint centre axis
      if (j > 0) {
        ctx.strokeStyle = '#173049';
        ctx.beginPath(); ctx.moveTo(ML + colW * j, MT); ctx.lineTo(ML + colW * j, MT + ph); ctx.stroke();
      }
      ctx.strokeStyle = '#264a68';
      ctx.beginPath(); ctx.moveTo(cx, MT); ctx.lineTo(cx, MT + ph); ctx.stroke();
      const lo = Math.max(0, s0), hi = Math.min(t.nSamples, s1);
      const nf = (hi > lo ? normFactorPercentile(t.samples.subarray(lo, hi), 0.95) : 0) || 1;
      wbDrawWiggle(ctx, t, cx, hw, MT, ph, s0, s1, nf, t.color);
      // per-column label
      ctx.fillStyle = t.color;
      ctx.font = '10px Consolas, monospace';
      ctx.textAlign = 'center';
      const lbl = `${t.sourceName} · ${t.traceIndex + 1}`;
      ctx.fillText(lbl.length > 22 ? lbl.slice(0, 21) + '…' : lbl, cx, MT + ph + 16);
      ctx.textAlign = 'left';
    }
  } else {
    // Overlay: all traces on ONE shared centre axis with a SHARED normalization
    // (max percentile over the visible window across the collection) so relative
    // amplitudes are comparable and aligned in time.
    const cx = ML + pw / 2;
    ctx.strokeStyle = '#264a68';
    ctx.beginPath(); ctx.moveTo(cx, MT); ctx.lineTo(cx, MT + ph); ctx.stroke();
    let nf = 0;
    for (const t of wbTraces) {
      const lo = Math.max(0, s0), hi = Math.min(t.nSamples, s1);
      if (hi <= lo) continue;
      const f = normFactorPercentile(t.samples.subarray(lo, hi), 0.95);
      if (f > nf) nf = f;
    }
    if (nf <= 0) nf = 1;
    for (const t of wbTraces) wbDrawWiggle(ctx, t, cx, pw / 2, MT, ph, s0, s1, nf, t.color);
  }

  // Legend (source · trace #) top-right, one row per colour.
  ctx.font = '10px Consolas, monospace';
  ctx.textAlign = 'left';
  let ly = MT + 4;
  for (const t of wbTraces) {
    ctx.fillStyle = t.color;
    ctx.fillRect(ML + pw - 150, ly, 9, 9);
    ctx.fillStyle = '#aab8c8';
    const lbl = `${t.sourceName} · ${t.traceIndex + 1}`;
    ctx.fillText(lbl.length > 20 ? lbl.slice(0, 19) + '…' : lbl, ML + pw - 137, ly + 8);
    ly += 13;
    if (ly > MT + ph - 12) break; // don't overflow the plot
  }

  // status label
  const lab = $opt('wbLabel');
  if (lab) lab.textContent = `${wbTraces.length} trace${wbTraces.length === 1 ? '' : 's'} · ${wbMode === 'side' ? 'side-by-side' : 'overlay'} · ${s0}–${s1} samples`;
}

// ── Trace Workbench · ANALYSIS (cross-correlation + difference + stats) ──
// Pick any two collected traces (A, B) and compare them numerically:
//  • normalized cross-correlation curve (r vs lag) with the peak marked,
//  • the difference trace A − B (drawn with the shared wiggle renderer),
//  • RMS amplitudes + B/A gain ratio.
// All compute is client-side (the samples already live in wbTraces) via the pure
// crossCorrelate/difference core ops — no worker round-trip.

let wbSelA = 0; // chosen A trace id (−1 ⇒ none)
let wbSelB = 0; // chosen B trace id (−1 ⇒ none)

/** Find a collected trace by id (null when absent). */
function wbTraceById(id: number): WbTrace | null {
  return wbTraces.find((t) => t.id === id) ?? null;
}

/** (Re)populate the A/B <select>s from the collection, preserving valid picks
 *  and defaulting to the first two distinct traces. */
function wbFillAnalysisSelects() {
  const selA = $opt('wbSelA') as HTMLSelectElement | null;
  const selB = $opt('wbSelB') as HTMLSelectElement | null;
  if (!selA || !selB) return;
  const opts = wbTraces
    .map((t) => `<option value="${t.id}">${t.sourceName} #${t.traceIndex + 1}</option>`)
    .join('');
  // Default picks: keep prior choices if still present, else first / second trace.
  if (!wbTraceById(wbSelA)) wbSelA = wbTraces[0]?.id ?? -1;
  if (!wbTraceById(wbSelB) || (wbTraces.length > 1 && wbSelB === wbSelA)) {
    wbSelB = wbTraces.find((t) => t.id !== wbSelA)?.id ?? wbTraces[0]?.id ?? -1;
  }
  selA.innerHTML = opts;
  selB.innerHTML = opts;
  if (wbSelA >= 0) selA.value = String(wbSelA);
  if (wbSelB >= 0) selB.value = String(wbSelB);
}

/** Plot a normalized cross-correlation curve (r vs lag ms) with the peak marked. */
function wbDrawCorr(cc: { lags: Float32Array; corr: Float32Array; bestLagMs: number; bestCoef: number }) {
  const cv = $opt('wbCorrCanvas') as HTMLCanvasElement | null;
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 800;
  const H = cv.clientHeight || 160;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0d1f33';
  ctx.fillRect(0, 0, W, H);

  const ML = 44, MR = 12, MT = 10, MB = 22;
  const pw = W - ML - MR, ph = H - MT - MB;
  ctx.strokeStyle = '#214564';
  ctx.lineWidth = 1;
  ctx.strokeRect(ML, MT, pw, ph);

  const n = cc.corr.length;
  if (n < 2) return;
  const lagMin = cc.lags[0], lagMax = cc.lags[n - 1];
  const lagSpan = lagMax - lagMin || 1;
  const xAt = (lagMs: number) => ML + ((lagMs - lagMin) / lagSpan) * pw;
  // r axis is [-1,1]; y grows downward, 0 in the middle.
  const yAt = (r: number) => MT + (1 - (r + 1) / 2) * ph;

  // grid: zero-lag vertical, r=0 horizontal, ±1 frame already drawn.
  ctx.strokeStyle = '#173049';
  ctx.beginPath(); ctx.moveTo(ML, yAt(0)); ctx.lineTo(ML + pw, yAt(0)); ctx.stroke();
  if (lagMin <= 0 && lagMax >= 0) {
    const xz = xAt(0);
    ctx.strokeStyle = '#264a68';
    ctx.beginPath(); ctx.moveTo(xz, MT); ctx.lineTo(xz, MT + ph); ctx.stroke();
  }

  // axis labels (lag ms across, r down)
  ctx.fillStyle = '#7e93ac';
  ctx.font = '10px Consolas, monospace';
  ctx.textAlign = 'center';
  for (let k = 0; k <= 4; k++) {
    const lag = lagMin + (lagSpan * k) / 4;
    ctx.fillText(lag.toFixed(0), ML + (pw * k) / 4, MT + ph + 14);
  }
  ctx.textAlign = 'right';
  ctx.fillText('+1', ML - 6, yAt(1) + 3);
  ctx.fillText(' 0', ML - 6, yAt(0) + 3);
  ctx.fillText('-1', ML - 6, yAt(-1) + 3);
  ctx.textAlign = 'left';

  // correlation curve
  ctx.strokeStyle = '#34dbd0';
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = xAt(cc.lags[i]);
    const y = yAt(Math.max(-1, Math.min(1, cc.corr[i])));
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // peak marker
  const px = xAt(cc.bestLagMs);
  const py = yAt(Math.max(-1, Math.min(1, cc.bestCoef)));
  ctx.fillStyle = '#ffb454';
  ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#ffb454';
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(px, MT); ctx.lineTo(px, MT + ph); ctx.stroke();
  ctx.setLineDash([]);
}

/** Draw the difference trace A − B in its own canvas (reuses wbDrawWiggle). */
function wbDrawDiff(diff: Float32Array, sampleInt: number) {
  const cv = $opt('wbDiffCanvas') as HTMLCanvasElement | null;
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 800;
  const H = cv.clientHeight || 200;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0d1f33';
  ctx.fillRect(0, 0, W, H);

  const ML = 60, MR = 14, MT = 14, MB = 26;
  const pw = W - ML - MR, ph = H - MT - MB;
  ctx.strokeStyle = '#214564';
  ctx.lineWidth = 1;
  ctx.strokeRect(ML, MT, pw, ph);

  const n = diff.length;
  if (n < 1) return;
  const s0 = 0, s1 = n;
  const denom = s1 - s0 > 1 ? s1 - s0 - 1 : 1;

  // time axis (ms down) — same labelling style as the main workbench canvas.
  ctx.fillStyle = '#7e93ac';
  ctx.font = '10px Consolas, monospace';
  const msPerSample = (sampleInt || 0) / 1000;
  for (let k = 0; k <= 5; k++) {
    const y = MT + (ph * k) / 5;
    const sampleAt = s0 + (denom * k) / 5;
    ctx.fillText((sampleAt * msPerSample).toFixed(0) + ' ms', 6, y + 3);
    ctx.strokeStyle = '#173049';
    ctx.beginPath(); ctx.moveTo(ML, y); ctx.lineTo(ML + pw, y); ctx.stroke();
  }

  const cx = ML + pw / 2;
  ctx.strokeStyle = '#264a68';
  ctx.beginPath(); ctx.moveTo(cx, MT); ctx.lineTo(cx, MT + ph); ctx.stroke();

  const nf = normFactorPercentile(diff, 0.95) || 1;
  const dtrace: WbTrace = { id: -1, sourceName: 'A−B', traceIndex: 0, samples: diff, sampleInt, nSamples: n, color: '#ff6e9c' };
  wbDrawWiggle(ctx, dtrace, cx, pw / 2, MT, ph, s0, s1, nf, '#ff6e9c');
}

/** Recompute + redraw the whole ANALYSIS section from the current A/B picks.
 *  Hides itself behind a placeholder when fewer than two traces are collected. */
function wbUpdateAnalysis() {
  const pick = $opt('wbAnalysisPick');
  const body = $opt('wbAnalysisBody');
  const empty = $opt('wbAnalysisEmpty');
  const readout = $opt('wbCorrReadout');
  const stats = $opt('wbStats');

  if (wbTraces.length < 2) {
    if (pick) (pick as HTMLElement).style.display = 'none';
    if (body) (body as HTMLElement).style.display = 'none';
    if (empty) (empty as HTMLElement).style.display = '';
    if (readout) readout.textContent = '—';
    if (stats) stats.textContent = '';
    return;
  }

  wbFillAnalysisSelects();
  if (pick) (pick as HTMLElement).style.display = '';
  if (body) (body as HTMLElement).style.display = '';
  if (empty) (empty as HTMLElement).style.display = 'none';

  const a = wbTraceById(wbSelA);
  const b = wbTraceById(wbSelB);
  if (!a || !b) return;

  const cc = crossCorrelate(a.samples, b.samples, a.sampleInt);
  const df = difference(a.samples, b.samples);

  wbDrawCorr(cc);
  wbDrawDiff(df.diff, a.sampleInt);

  if (readout) readout.textContent = `best lag = ${cc.bestLagMs.toFixed(2)} ms · r = ${cc.bestCoef.toFixed(3)}`;
  if (stats) {
    stats.textContent =
      `RMS A=${df.rmsA.toPrecision(4)} · RMS B=${df.rmsB.toPrecision(4)} · ` +
      `RMS(A−B)=${df.rmsDiff.toPrecision(4)} · gain B/A=${df.gainRatio.toFixed(3)}`;
  }
}

// ── Trace Workbench · EXPORT ──
// Write the collected traces out as ONE seismic file in the chosen writer format.
// Mirrors the Converter's SAVE flow: the worker assembles a synthetic ParsedFile
// from the samples and runs the writer; main shows the native Save dialog. The
// button is disabled while the collection is empty; a note appears when the
// collected traces carry DIFFERENT sample intervals (the output uses the first).

/** Sync the EXPORT controls to the collection: enable/disable the button and
 *  show the mixed-sample-interval note when traces disagree on dt. */
function wbUpdateExport() {
  const btn = $opt('wbExportBtn') as HTMLButtonElement | null;
  if (btn) btn.disabled = wbTraces.length === 0;
  const note = $opt('wbExportSiNote');
  if (note) {
    const first = wbTraces[0]?.sampleInt;
    const mixed = wbTraces.length > 1 && wbTraces.some((t) => t.sampleInt !== first);
    (note as HTMLElement).style.display = mixed ? '' : 'none';
  }
}

/** Export the collected traces as a single seismic file in the chosen format. */
async function wbExport() {
  if (!wbTraces.length) return;
  const fmt = ($opt('wbExportFmt') as HTMLSelectElement | null)?.value || 'segy1';
  const btn = $opt('wbExportBtn') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  setStatus('wbExportStatus', 'Writing…');
  try {
    const r = await api.convertTraces({
      traces: wbTraces.map((t) => ({ samples: t.samples, nSamples: t.nSamples, sampleInt: t.sampleInt })),
      sampleInt: wbTraces[0]?.sampleInt,
      format: fmt,
      baseName: 'workbench',
    });
    if (r.ok) setStatus('wbExportStatus', '✓ Saved ' + r.path, 'ok');
    else if (r.canceled) setStatus('wbExportStatus', '');
    else setStatus('wbExportStatus', 'Export failed: ' + (r.error || 'unknown'), 'err');
  } catch (e) {
    setStatus('wbExportStatus', 'Export failed: ' + errMsg(e), 'err');
  } finally {
    wbUpdateExport(); // re-enable per current collection state
  }
}

/** Attach wheel-zoom / drag-pan / dblclick-fit to the workbench canvas (once). */
function workbenchInteractions() {
  const cv = $opt('wbCanvas') as HTMLCanvasElement | null;
  if (!cv) return;
  const active = () => $('panel-workbench').style.display !== 'none' && !!wbTraces.length;
  let dragging = false, ly = 0;
  cv.addEventListener('wheel', (e) => {
    if (!active()) return;
    e.preventDefault();
    const fy = wbPlotFrac(cv, e);
    wbZoomAt(fy, e.deltaY < 0 ? 1 / 1.15 : 1.15);
    drawWorkbench();
  }, { passive: false });
  cv.addEventListener('mousedown', (e) => {
    if (!active()) return;
    dragging = true; ly = e.clientY; cv.style.cursor = 'grabbing';
  });
  window.addEventListener('mouseup', () => { dragging = false; cv.style.cursor = ''; });
  cv.addEventListener('mousemove', (e) => {
    if (!dragging || !wbView.init || !active()) return;
    const H = cv.clientHeight || 460;
    const MT = 14, MB = 26, ph = H - MT - MB;
    if (ph <= 0) return;
    const ds = ((e.clientY - ly) / ph) * (wbView.s1 - wbView.s0);
    wbView.s0 -= ds; wbView.s1 -= ds;
    wbClamp();
    ly = e.clientY;
    drawWorkbench();
  });
  cv.addEventListener('dblclick', () => {
    if (!active()) return;
    wbFit(); drawWorkbench();
  });
  $opt('wbPickBtn')?.addEventListener('click', () => void wbPickAndAdd());
  $opt('wbAddOpenBtn')?.addEventListener('click', wbAddOpenTrace);
  $opt('wbClearBtn')?.addEventListener('click', wbClear);
  $opt('wbModeSide')?.addEventListener('click', () => wbSetMode('side'));
  $opt('wbModeOverlay')?.addEventListener('click', () => wbSetMode('overlay'));
  $opt('wbZoomIn')?.addEventListener('click', () => wbZoomButton(1 / 1.4));
  $opt('wbZoomOut')?.addEventListener('click', () => wbZoomButton(1.4));
  $opt('wbZoomFit')?.addEventListener('click', () => { wbFit(); drawWorkbench(); });
  // ANALYSIS A/B pickers → recompute on change.
  $opt('wbSelA')?.addEventListener('change', (e) => {
    wbSelA = parseInt((e.target as HTMLSelectElement).value, 10);
    wbUpdateAnalysis();
  });
  $opt('wbSelB')?.addEventListener('change', (e) => {
    wbSelB = parseInt((e.target as HTMLSelectElement).value, 10);
    wbUpdateAnalysis();
  });
  // EXPORT: write the collected traces out as one seismic file.
  $opt('wbExportBtn')?.addEventListener('click', () => void wbExport());
  renderWorkbenchList();
  wbUpdateAnalysis();
  wbUpdateExport();
}

// ── SPS 2.1 (survey geometry) ──
function spsLabel(s: SpsSummary): string {
  const proj = s.projection?.desc || s.projection?.type || s.projection?.subtype || 'unknown CRS';
  return `${s.sources} sources · ${s.receivers} receivers · ${s.xrefs} X-refs · ${s.layout || '?'} · ${proj}` + (s.errors.length ? ` · ⚠ ${s.errors.length}` : '');
}

/** Paint the dedicated SPS stats element (counts + line totals). Lives apart
 *  from #spsLabel, which hoverGrid overwrites. Line counts come from geometry. */
function updateSpsStats() {
  const el = $opt('spsStats');
  if (!el) return;
  if (!spsSummary) { el.textContent = ''; return; }
  const srcLines = spsGeom ? spsGeom.src.names.length : 0;
  const rcvLines = spsGeom ? spsGeom.rcv.names.length : 0;
  el.textContent =
    `${spsSummary.sources} sources · ${spsSummary.receivers} receivers · ${spsSummary.xrefs} X-refs · ${srcLines} src lines · ${rcvLines} rcv lines`;
}

// ── Station inspector (full point detail, fetched from the worker on click) ──
/** Hide + empty the inspector card. */
function clearInspector() {
  const card = $opt('spsInspector');
  if (card) card.style.display = 'none';
  const body = $opt('spsInspBody');
  if (body) body.innerHTML = '';
}

/** Append one key/value row to the inspector body (reuses the .kv styling).
 *  `full` rows span both columns (used for the raw SPS line). */
function kvRow(parent: HTMLElement, k: string, v: string, full = false) {
  const row = document.createElement('div');
  row.className = 'kv' + (full ? ' full' : '');
  const ks = document.createElement('span'); ks.className = 'k'; ks.textContent = k;
  const vs = document.createElement('span'); vs.className = 'v mono'; vs.textContent = v;
  row.appendChild(ks); row.appendChild(vs);
  parent.appendChild(row);
}

/** Render a fetched point's full field set into the inspector card. Guards
 *  NaN / empty / undefined so only meaningful fields show. */
function showInspector(d: SPSPointDetail) {
  const card = $opt('spsInspector');
  const body = $opt('spsInspBody');
  const title = $opt('spsInspTitle');
  if (!card || !body) return;
  body.innerHTML = '';
  const isSrc = d.rtype === 'S';
  if (title) title.textContent = `${isSrc ? 'Source' : 'Receiver'} — Line ${d.lineName || '?'} · pt ${d.point}`;
  const numOk = (v: number | undefined): v is number => v != null && isFinite(v);
  const strOk = (v: string | undefined): v is string => v != null && v.trim() !== '';

  kvRow(body, 'Type', isSrc ? 'Source (S)' : 'Receiver (R)');
  kvRow(body, 'Line', d.lineName || '—');
  kvRow(body, 'Point', String(d.point));
  if (strOk(d.idx)) kvRow(body, 'Index', d.idx);
  if (numOk(d.easting)) kvRow(body, 'Easting', d.easting.toFixed(2));
  if (numOk(d.northing)) kvRow(body, 'Northing', d.northing.toFixed(2));
  if (numOk(d.elevation)) kvRow(body, 'Elevation', d.elevation.toFixed(2) + ' m');
  if (isSrc) {
    if (numOk(d.upholeMs) && d.upholeMs !== 0) kvRow(body, 'Uphole', d.upholeMs.toFixed(1) + ' ms');
    if (strOk(d.srcType)) kvRow(body, 'Source type', d.srcType);
    if (strOk(d.date)) kvRow(body, 'Date', d.date);
    if (strOk(d.time)) kvRow(body, 'Time', d.time);
    if (numOk(d.ffid) && d.ffid !== 0) kvRow(body, 'FFID', String(d.ffid));
  } else if (numOk(d.staticMs) && d.staticMs !== 0) {
    kvRow(body, 'Static', d.staticMs.toFixed(1) + ' ms');
  }
  if (strOk(d.raw)) kvRow(body, 'Raw', d.raw.trimEnd(), true);
  card.style.display = 'block';
}

/** Fetch + show one point's detail by S/R line + point. Best-effort: a missing
 *  match (or no SPS) simply leaves the inspector untouched. */
async function inspectPoint(rtype: 'S' | 'R', lineName: string, point: number) {
  try {
    const d = await api.spsPointDetail({ rtype, lineName, point });
    if (d) showInspector(d);
  } catch { /* ignore — inspector stays as-is */ }
}

/** Center the survey grid on a world point (current geometry space) + highlight
 *  it. Pans the cached transform without changing scale. */
function jumpGridTo(x: number, y: number) {
  if (!spsGeom) return;
  const cv = $('spsCanvas') as HTMLCanvasElement;
  if (!gridView.init) gridFit();
  const W = cv.clientWidth || 900, H = cv.clientHeight || 500;
  gridView.ox = W / 2 - x * gridView.sc;
  gridView.oy = H / 2 + y * gridView.sc;
  gridHighlight = { x, y };
  drawSurveyGrid();
}

/** Pan + highlight the Leaflet map at lat/lon (when the map view is active). */
function jumpMapTo(lat: number, lon: number) {
  if (!leafletMap || !isFinite(lat) || !isFinite(lon)) return;
  const map = leafletMap;
  map.panTo([lat, lon]);
  if (mapHighlight) { map.removeLayer(mapHighlight); mapHighlight = null; }
  mapHighlight = L.circleMarker([lat, lon], { radius: 11, color: '#ffe04a', weight: 3, fill: false }).addTo(map);
}

/** Locate a point's coords in the CURRENT geometry arrays (already transformed
 *  for the active view) by rtype + line + point. Returns null if not present. */
function geomCoordsFor(rtype: 'S' | 'R', lineName: string, point: number): { x: number; y: number } | null {
  if (!spsGeom) return null;
  const g = rtype === 'S' ? spsGeom.src : spsGeom.rcv;
  const want = (lineName || '').trim();
  for (let i = 0; i < g.x.length; i++) {
    if (g.pt[i] === point && (g.names[g.line[i]] || '').trim() === want) return { x: g.x[i], y: g.y[i] };
  }
  return null;
}

/** Focus a QC / clicked point: center the grid + ring it, mirror onto the map if
 *  active, and open the inspector. `qp` carries the geometry-independent key. */
function focusPoint(qp: QCPoint) {
  const c = geomCoordsFor(qp.rtype, qp.lineName, qp.point);
  if (c) {
    if (spsView === 'grid') jumpGridTo(c.x, c.y);
    else gridHighlight = { x: c.x, y: c.y }; // ring shows when the grid is next drawn
    // In map space the geometry arrays already hold lon/lat (x=lon, y=lat).
    if (spsView === 'map') jumpMapTo(c.y, c.x);
  }
  void inspectPoint(qp.rtype, qp.lineName, qp.point);
}

async function loadSPS() {
  $('spsLabel').textContent = 'Loading…';
  try {
    const s = await api.openSPS();
    if (!s) {
      $('spsLabel').textContent = spsSummary ? spsLabel(spsSummary) : 'Load S/R/X files to plot the survey';
      return;
    }
    spsSummary = s;
    setSpsExportEnabled(true);
    spsGeom = null;
    spsSpider = null;
    spsFold = null;
    spsFoldBin = 0;
    highlightedShot = null;
    gridView.init = false;
    gridHighlight = null;
    clearInspector();
    $('spsLabel').textContent = spsLabel(s);
    updateSpsStats();
    // CRS is now known — refresh the File-summary + status-strip CRS cells.
    renderSummaryPanel();
    updateStatusStrip();
    await refreshSps();
  } catch (e) {
    $('spsLabel').textContent = 'SPS load failed: ' + errMsg(e);
  }
}

/** Fetch geometry for the active view (projected E/N for grid, WGS84 lon/lat for map) and render. */
async function refreshSps() {
  if (!spsSummary) return;
  // Geographic (map) view needs a projected CRS in the SPS header; if a freshly
  // loaded survey lacks one while we're on the map, fall back to the grid.
  if (spsView === 'map' && !spsSummary.projection) {
    spsView = 'grid';
    $('viewGrid').classList.add('on');
    $('viewMap').classList.remove('on');
    ($('spsCanvas') as HTMLElement).style.display = 'block';
    $('spsMap').style.display = 'none';
    $('spsLabel').textContent = 'Real map needs a projected CRS in the SPS header — showing Survey grid.';
  }
  const wantGeo = spsView === 'map';
  if (!spsGeom || spsGeom.geo !== wantGeo) {
    try {
      spsGeom = await api.spsGeometry(wantGeo);
      gridView.init = false;
      // Geometry space (E/N vs lon/lat) changed → any stale highlight is invalid.
      gridHighlight = null;
      spsSpider = null; // spider endpoints are in the old geometry space; refetch on demand
      updateSpsStats(); // line counts come from geometry
    } catch (e) {
      $('spsLabel').textContent = 'SPS geometry failed: ' + errMsg(e);
      return;
    }
  }
  // Keep the spider in sync with the active geometry space when it's enabled.
  if (spsView === 'grid' && spsShowXrefs() && (!spsSpider || spsSpider.geo !== wantGeo)) {
    await ensureSpider();
  }
  // Fold map is grid-view + projected-E/N only (it's a planning heatmap). Fetch
  // it lazily the first time it's toggled on, and whenever the bin size changes.
  if (spsView === 'grid' && !spsGeom.geo && spsShowFold()) {
    await ensureFold();
  }
  if (spsView === 'grid') drawSurveyGrid();
  else updateMap();
}

/** Whether the X-ref spider toggle is on (absent checkbox ⇒ off). */
function spsShowXrefs(): boolean {
  return !!($opt('spsShowXrefs') as HTMLInputElement | null)?.checked;
}

/** Fetch + cache the spider for the active geometry space (no-op if current).
 *  Best-effort: a failure just leaves spsSpider null so the grid draws as before. */
async function ensureSpider(): Promise<void> {
  const wantGeo = spsView === 'map';
  if (spsSpider && spsSpider.geo === wantGeo) return;
  try {
    spsSpider = await api.spsXrefLines(wantGeo);
    if (spsSpider.decimated && spsSpider.log) $('spsLabel').textContent = spsSpider.log;
  } catch (e) {
    spsSpider = null;
    $('spsLabel').textContent = 'X-ref spider failed: ' + errMsg(e);
  }
}

/** Whether the Fold/coverage toggle is on (absent checkbox ⇒ off). */
function spsShowFold(): boolean {
  return !!($opt('spsShowFold') as HTMLInputElement | null)?.checked;
}

/** Current bin size (m) from the toolbar input; clamps to ≥ 1, default 25. */
function spsBinSize(): number {
  const v = parseFloat(($opt('spsBinSize') as HTMLInputElement | null)?.value ?? '');
  return isFinite(v) && v >= 1 ? v : 25;
}

/** Fetch + cache the fold map for the current bin size (no-op if already current).
 *  Best-effort: a failure (e.g. bin too small) leaves spsFold null and surfaces
 *  the reason in the status label, so the grid still draws without the heatmap. */
async function ensureFold(): Promise<void> {
  const bin = spsBinSize();
  if (spsFold && spsFoldBin === bin) return;
  try {
    spsFold = await api.spsFold({ binX: bin, binY: bin });
    spsFoldBin = bin;
    if (spsFold.log) $('spsLabel').textContent = spsFold.log;
  } catch (e) {
    spsFold = null;
    spsFoldBin = 0;
    $('spsLabel').textContent = 'Fold map failed: ' + errMsg(e);
  }
}

function setView(v: 'grid' | 'map') {
  if (spsView === v) return;
  if (v === 'map' && (!spsSummary || !spsSummary.projection)) {
    $('spsLabel').textContent = 'Real map needs a projected CRS in the SPS header — staying on Survey grid.';
    return;
  }
  spsView = v;
  $('viewGrid').classList.toggle('on', v === 'grid');
  $('viewMap').classList.toggle('on', v === 'map');
  ($('spsCanvas') as HTMLElement).style.display = v === 'grid' ? 'block' : 'none';
  $('spsMap').style.display = v === 'map' ? 'block' : 'none';
  if (spsSummary) void refreshSps();
}

// ── Survey-grid canvas (projected E/N, always offline) ──
function gridFit() {
  if (!spsGeom) return;
  const cv = $('spsCanvas') as HTMLCanvasElement;
  const W = cv.clientWidth || 900, H = cv.clientHeight || 500;
  const { minX, maxX, minY, maxY } = spsGeom.bbox;
  if (!isFinite(minX)) { gridView.sc = 1; gridView.ox = W / 2; gridView.oy = H / 2; gridView.init = true; return; }
  const dx = Math.max(1e-9, maxX - minX), dy = Math.max(1e-9, maxY - minY);
  const sc = Math.min((W - 80) / dx, (H - 56) / dy) * 0.96;
  gridView.sc = sc;
  gridView.ox = W / 2 - (sc * (minX + maxX)) / 2;
  gridView.oy = H / 2 + (sc * (minY + maxY)) / 2;
  gridView.init = true;
}

function niceStep(range: number, target: number): number {
  const raw = range / Math.max(1, target);
  if (!isFinite(raw) || raw <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

function drawSurveyGrid() {
  if (!spsGeom) return;
  const cv = $('spsCanvas') as HTMLCanvasElement;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 900, H = cv.clientHeight || 500;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#0f2540'); bg.addColorStop(1, '#0b1a2c');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  if (!gridView.init) gridFit();
  const { sc, ox, oy } = gridView;
  const geo = spsGeom.geo;
  const X = (e: number) => ox + e * sc;
  const Yf = (n: number) => oy - n * sc;
  const showS = ($('spsShowS') as HTMLInputElement).checked;
  const showR = ($('spsShowR') as HTMLInputElement).checked;

  // visible world extent → "nice" gridlines + axis labels
  const e0 = (0 - ox) / sc, e1 = (W - ox) / sc;
  const nTop = (oy - 0) / sc, nBot = (oy - H) / sc;
  const pr = geo ? 4 : 0;
  ctx.lineWidth = 1; ctx.font = '10px Consolas, monospace';
  const sx = niceStep(e1 - e0, 8);
  for (let e = Math.ceil(e0 / sx) * sx; e <= e1; e += sx) {
    const x = X(e); if (x < 42 || x > W - 2) continue;
    ctx.strokeStyle = 'rgba(33,69,100,0.45)';
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H - 16); ctx.stroke();
    ctx.fillStyle = '#5e7186'; ctx.fillText(e.toFixed(pr), x + 2, H - 5);
  }
  const sy = niceStep(nTop - nBot, 6);
  for (let n = Math.ceil(nBot / sy) * sy; n <= nTop; n += sy) {
    const y = Yf(n); if (y < 2 || y > H - 16) continue;
    ctx.strokeStyle = 'rgba(33,69,100,0.45)';
    ctx.beginPath(); ctx.moveTo(42, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.fillStyle = '#5e7186'; ctx.fillText(n.toFixed(pr), 3, y - 2);
  }

  // FOLD / coverage heatmap, drawn UNDER everything else (grid view + projected
  // E/N only — skip on the map view or in geographic space). Each non-empty bin
  // is a viridis-tinted rect at alpha 0.6; viewport-culled to the visible cells.
  // Uses X()/Yf() so it tracks pan/zoom exactly like the points.
  let foldDrawn = false;
  if (spsShowFold() && !geo && spsFold && spsFold.maxFold > 0) {
    const f = spsFold;
    ctx.save();
    ctx.globalAlpha = 0.6;
    // Visible world rectangle → bin index range (cull cells outside it).
    const ix0 = Math.max(0, Math.floor((e0 - f.originX) / f.binX));
    const ix1 = Math.min(f.nx - 1, Math.ceil((e1 - f.originX) / f.binX));
    const iy0 = Math.max(0, Math.floor((nBot - f.originY) / f.binY));
    const iy1 = Math.min(f.ny - 1, Math.ceil((nTop - f.originY) / f.binY));
    const inv = 1 / f.maxFold;
    for (let iy = iy0; iy <= iy1; iy++) {
      const rowBase = iy * f.nx;
      // Cell rows go bottom-up in world N; in canvas the rect spans from the
      // top edge Yf(originY+(iy+1)*binY) down to Yf(originY+iy*binY).
      const yTop = Yf(f.originY + (iy + 1) * f.binY);
      const yBot = Yf(f.originY + iy * f.binY);
      const rh = yBot - yTop;
      for (let ix = ix0; ix <= ix1; ix++) {
        const v = f.fold[rowBase + ix];
        if (v <= 0) continue;
        // Map fold/maxFold (0..1) onto viridis, whose input is -1..1.
        const [r, g2, b] = colorViridis(v * inv * 2 - 1);
        ctx.fillStyle = `rgb(${r},${g2},${b})`;
        const xL = X(f.originX + ix * f.binX);
        const xR = X(f.originX + (ix + 1) * f.binX);
        ctx.fillRect(xL, yTop, xR - xL, rh);
      }
    }
    ctx.restore();
    foldDrawn = true;
  }

  // X-ref "spider": shot→receiver segments, drawn UNDER the points. Thin + low
  // opacity for the full set; if a shot is highlighted, dim the rest and over-
  // draw that shot's fan bright. Off-screen segments are cheaply skipped.
  if (spsShowXrefs() && spsSpider && spsSpider.geo === geo) {
    const sp = spsSpider;
    const hiGid = highlightedShot != null ? sp.shotKeys.indexOf(highlightedShot) : -1;
    const inView = (x: number, y: number) => x >= -50 && x <= W + 50 && y >= -50 && y <= H + 50;
    const drawSegs = (only: number, col: string, lw: number) => {
      ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.beginPath();
      for (let i = 0; i < sp.sx.length; i++) {
        if (only >= 0 ? sp.shot[i] !== only : (hiGid >= 0 && sp.shot[i] === hiGid)) continue;
        const ax = X(sp.sx[i]), ay = Yf(sp.sy[i]), bx = X(sp.rx[i]), by = Yf(sp.ry[i]);
        if (!inView(ax, ay) && !inView(bx, by)) continue;
        ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      }
      ctx.stroke();
    };
    // Base layer: all segments (dimmer when a shot is singled out).
    drawSegs(-1, hiGid >= 0 ? 'rgba(45,212,191,0.05)' : 'rgba(45,212,191,0.12)', 0.5);
    // Emphasized shot on top.
    if (hiGid >= 0) drawSegs(hiGid, 'rgba(45,212,191,0.85)', 1.2);
  }

  // survey lines (polyline per contiguous same-line run) + glowing points
  const drawSet = (g: SpsLines, lineCol: string, ptCol: string) => {
    ctx.strokeStyle = lineCol; ctx.lineWidth = 1.1;
    let cur = -1; ctx.beginPath();
    for (let i = 0; i < g.x.length; i++) {
      const e = g.x[i], n = g.y[i];
      if (!isFinite(e) || !isFinite(n)) { cur = -1; continue; }
      const x = X(e), y = Yf(n);
      if (g.line[i] !== cur) { ctx.moveTo(x, y); cur = g.line[i]; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = ptCol; ctx.shadowColor = ptCol; ctx.shadowBlur = 6;
    for (let i = 0; i < g.x.length; i++) {
      const e = g.x[i], n = g.y[i];
      if (!isFinite(e) || !isFinite(n)) continue;
      ctx.beginPath(); ctx.arc(X(e), Yf(n), 1.8, 0, Math.PI * 2); ctx.fill();
    }
    ctx.shadowBlur = 0;
  };
  if (showR) drawSet(spsGeom.rcv, 'rgba(58,160,224,0.45)', '#3aa0e0');
  if (showS) drawSet(spsGeom.src, 'rgba(255,140,0,0.5)', '#ff8c00');

  // Highlight ring for a clicked / jumped-to point (drawn in the current geometry
  // space, so it tracks pan/zoom). A double ring stands out over either layer.
  if (gridHighlight && isFinite(gridHighlight.x) && isFinite(gridHighlight.y)) {
    const hx = X(gridHighlight.x), hy = Yf(gridHighlight.y);
    ctx.strokeStyle = '#ffe04a'; ctx.lineWidth = 2; ctx.shadowColor = '#ffe04a'; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.arc(hx, hy, 9, 0, Math.PI * 2); ctx.stroke();
    ctx.shadowBlur = 0; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(hx, hy, 4, 0, Math.PI * 2); ctx.stroke();
  }

  // legend
  ctx.font = '11px "Segoe UI", sans-serif';
  let lx = 52; const ly = 20;
  const legend = (col: string, txt: string) => {
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(lx, ly, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#c8d2e0'; ctx.fillText(txt, lx + 9, ly + 4); lx += ctx.measureText(txt).width + 34;
  };
  if (showS) legend('#ff8c00', `${spsSummary?.sources ?? 0} sources`);
  if (showR) legend('#3aa0e0', `${spsSummary?.receivers ?? 0} receivers`);

  // Fold colorbar (vertical viridis gradient, 0..maxFold) in the bottom-left.
  if (foldDrawn && spsFold) drawFoldColorbar(ctx, H, spsFold.maxFold);
  // Fold is on but can't render here (geographic space) — a small hint.
  else if (spsShowFold() && geo) {
    ctx.font = '11px "Segoe UI", sans-serif'; ctx.fillStyle = '#9fb0c4';
    ctx.fillText('Fold/coverage: Survey-grid view only', 52, ly + 20);
  }

  // north arrow (north-up)
  ctx.fillStyle = '#9fb0c4'; ctx.font = 'bold 12px Consolas, monospace';
  ctx.fillText('N', W - 22, 24);
  ctx.strokeStyle = '#9fb0c4'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(W - 18, 28); ctx.lineTo(W - 18, 40);
  ctx.moveTo(W - 18, 28); ctx.lineTo(W - 21, 33);
  ctx.moveTo(W - 18, 28); ctx.lineTo(W - 15, 33);
  ctx.stroke();

  drawScaleBar(ctx, W, H, sc, geo, (nTop + nBot) / 2);
}

function drawScaleBar(ctx: CanvasRenderingContext2D, W: number, H: number, scPxPerUnit: number, geo: boolean, midLat: number) {
  const mPerUnit = geo ? 111320 * Math.cos((midLat * Math.PI) / 180) : 1;
  const pxPerM = scPxPerUnit / mPerUnit;
  if (!isFinite(pxPerM) || pxPerM <= 0) return;
  const meters = niceStep(120 / pxPerM, 1);
  const barPx = meters * pxPerM;
  if (!isFinite(barPx) || barPx < 12 || barPx > W - 60) return;
  const x0 = W - 22 - barPx, y0 = H - 22;
  ctx.strokeStyle = '#c8d2e0'; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x0, y0); ctx.lineTo(x0 + barPx, y0);
  ctx.moveTo(x0, y0 - 4); ctx.lineTo(x0, y0 + 4);
  ctx.moveTo(x0 + barPx, y0 - 4); ctx.lineTo(x0 + barPx, y0 + 4);
  ctx.stroke();
  ctx.fillStyle = '#c8d2e0'; ctx.font = '10px Consolas, monospace'; ctx.textAlign = 'center';
  ctx.fillText(meters >= 1000 ? `${meters / 1000} km` : `${meters} m`, x0 + barPx / 2, y0 - 6);
  ctx.textAlign = 'left';
}

/** Vertical viridis gradient legend (top = maxFold, bottom = 0) for the fold map,
 *  drawn in the lower-left corner. Colors match the heatmap (fold/maxFold → viridis). */
function drawFoldColorbar(ctx: CanvasRenderingContext2D, H: number, maxFold: number) {
  const bw = 12, bh = 120;
  const x0 = 52, y0 = H - 28 - bh;
  // Top (maxFold) → bottom (0); sample viridis the same way the heatmap does.
  for (let p = 0; p < bh; p++) {
    const t = 1 - p / (bh - 1); // 1 at top, 0 at bottom
    const [r, g, b] = colorViridis(t * 2 - 1);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(x0, y0 + p, bw, 1);
  }
  ctx.strokeStyle = 'rgba(200,210,224,0.5)'; ctx.lineWidth = 1;
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, bw, bh);
  ctx.fillStyle = '#c8d2e0'; ctx.font = '10px Consolas, monospace'; ctx.textAlign = 'left';
  ctx.fillText(String(maxFold), x0 + bw + 4, y0 + 8);
  ctx.fillText('0', x0 + bw + 4, y0 + bh);
  ctx.fillStyle = '#9fb0c4'; ctx.fillText('fold', x0, y0 - 4);
}

/** Attach wheel-zoom / drag-pan / hover to the grid canvas (once, at init). */
function gridInteractions() {
  const cv = $('spsCanvas') as HTMLCanvasElement;
  let dragging = false, lx = 0, ly = 0;
  // Track drag distance so a pan (press-move-release) doesn't open the inspector;
  // only a near-stationary press counts as a station click.
  let downX = 0, downY = 0, moved = 0;
  cv.addEventListener('wheel', (e) => {
    if (spsView !== 'grid' || !spsGeom) return;
    e.preventDefault();
    if (!gridView.init) gridFit();
    const r = cv.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const ex = (px - gridView.ox) / gridView.sc, ny = (gridView.oy - py) / gridView.sc;
    gridView.sc *= e.deltaY < 0 ? 1.15 : 1 / 1.15;
    gridView.ox = px - ex * gridView.sc;
    gridView.oy = py + ny * gridView.sc;
    drawSurveyGrid();
  }, { passive: false });
  cv.addEventListener('mousedown', (e) => { if (spsView !== 'grid') return; dragging = true; lx = e.clientX; ly = e.clientY; downX = e.clientX; downY = e.clientY; moved = 0; });
  window.addEventListener('mouseup', () => { dragging = false; });
  cv.addEventListener('mousemove', (e) => {
    if (spsView !== 'grid' || !spsGeom) return;
    if (dragging) {
      moved += Math.abs(e.clientX - lx) + Math.abs(e.clientY - ly);
      gridView.ox += e.clientX - lx; gridView.oy += e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      drawSurveyGrid();
    } else {
      hoverGrid(e);
    }
  });
  // A click (press + release without a real drag) opens the station inspector.
  cv.addEventListener('click', (e) => {
    if (moved > 4 || Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 4) return;
    clickGrid(e);
  });
  cv.addEventListener('dblclick', () => { if (spsView === 'grid' && spsGeom) { gridFit(); drawSurveyGrid(); } });
  // Keep the active SPS view correct after a window resize (the cached grid
  // transform would otherwise go stale; Leaflet needs invalidateSize).
  window.addEventListener('resize', () => {
    if (spsView === 'grid' && spsGeom) { gridFit(); drawSurveyGrid(); }
    else if (spsView === 'map' && leafletMap) leafletMap.invalidateSize();
  });
}

/** Nearest survey point to a canvas pixel (squared-distance over the visible
 *  S/R layers, 144 px² threshold). Returns the group + index, or null. Shared
 *  by hover (label) and click (inspector). */
function pickGridPoint(e: MouseEvent): { g: SpsLines; i: number } | null {
  if (!spsGeom || !gridView.init) return null;
  const cv = $('spsCanvas') as HTMLCanvasElement;
  const r = cv.getBoundingClientRect();
  const px = e.clientX - r.left, py = e.clientY - r.top;
  const { sc, ox, oy } = gridView;
  let best = 144, bi = -1, bg: SpsLines | null = null;
  const scan = (g: SpsLines, on: boolean) => {
    if (!on) return;
    for (let i = 0; i < g.x.length; i++) {
      const x = ox + g.x[i] * sc, y = oy - g.y[i] * sc;
      const d = (x - px) ** 2 + (y - py) ** 2;
      if (d < best) { best = d; bi = i; bg = g; }
    }
  };
  scan(spsGeom.src, ($('spsShowS') as HTMLInputElement).checked);
  scan(spsGeom.rcv, ($('spsShowR') as HTMLInputElement).checked);
  return bg && bi >= 0 ? { g: bg, i: bi } : null;
}

function hoverGrid(e: MouseEvent) {
  if (!spsGeom || !gridView.init) return;
  const hit = pickGridPoint(e);
  if (hit) {
    const { g, i } = hit;
    const pr = spsGeom.geo ? 5 : 1;
    $('spsLabel').textContent = `Line ${g.names[g.line[i]]} · pt ${g.pt[i]} · ${g.x[i].toFixed(pr)}, ${g.y[i].toFixed(pr)}`;
  } else if (spsSummary) {
    $('spsLabel').textContent = spsLabel(spsSummary);
  }
}

/** Open the inspector for a clicked grid point (rtype inferred from which layer
 *  the pick came from) + ring it. No-op when the click missed every station. */
function clickGrid(e: MouseEvent) {
  if (spsView !== 'grid' || !spsGeom) return;
  const hit = pickGridPoint(e);
  if (!hit) {
    // Empty space → drop any shot emphasis (and ring) and redraw.
    if (highlightedShot != null) { highlightedShot = null; drawSurveyGrid(); }
    return;
  }
  const { g, i } = hit;
  const rtype: 'S' | 'R' = g === spsGeom.src ? 'S' : 'R';
  gridHighlight = { x: g.x[i], y: g.y[i] };
  // Clicking a SOURCE emphasizes its spider fan; clicking a receiver clears it.
  // The key matches the worker's shotKeys ('trimmed(srcLine)|point').
  highlightedShot = rtype === 'S' ? `${(g.names[g.line[i]] || '').trim()}|${g.pt[i]}` : null;
  drawSurveyGrid();
  void inspectPoint(rtype, g.names[g.line[i]], g.pt[i]);
}

// ── Real basemap (Leaflet, geographic) ──
function ensureMap() {
  if (leafletMap) return;
  // maxZoom 24 with per-source maxNativeZoom lets the basemap keep zooming PAST the
  // tile providers' native levels (upscaled) for sub-meter survey detail.
  const dark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', { maxZoom: 24, maxNativeZoom: 20, attribution: '© OpenStreetMap, © CARTO' });
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 24, maxNativeZoom: 21, attribution: 'Esri World Imagery' });
  const streets = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 24, maxNativeZoom: 19, attribution: '© OpenStreetMap' });
  leafletMap = L.map('spsMap', { layers: [dark], preferCanvas: true, maxZoom: 24, zoomSnap: 0.5 });
  L.control.layers({ Dark: dark, Satellite: sat, Streets: streets }).addTo(leafletMap);
  leafletMap.setView([32, 35], 6);
}

function updateMap() {
  if (!spsGeom || !spsGeom.geo) return;
  ensureMap();
  const map = leafletMap!;
  map.invalidateSize();
  if (leafletLayers) { map.removeLayer(leafletLayers.src); map.removeLayer(leafletLayers.rcv); leafletLayers = null; }
  if (mapHighlight) { map.removeLayer(mapHighlight); mapHighlight = null; }
  const showS = ($('spsShowS') as HTMLInputElement).checked;
  const showR = ($('spsShowR') as HTMLInputElement).checked;
  // Lines always draw in full; station markers are decimated so a 50k-point
  // survey can't flood the map renderer (each marker is a canvas circle + popup).
  const MAX_MARKERS = 6000;
  const build = (g: SpsLines, col: string, rtype: 'S' | 'R') => {
    const grp = L.layerGroup();
    const stride = Math.max(1, Math.ceil(g.x.length / MAX_MARKERS));
    let cur = -1; let coords: [number, number][] = [];
    const flush = () => { if (coords.length > 1) L.polyline(coords, { color: col, weight: 1, opacity: 0.5 }).addTo(grp); coords = []; };
    for (let i = 0; i < g.x.length; i++) {
      const lon = g.x[i], lat = g.y[i];
      if (!isFinite(lon) || !isFinite(lat)) { flush(); cur = -1; continue; }
      if (g.line[i] !== cur) { flush(); cur = g.line[i]; }
      coords.push([lat, lon]);
      if (i % stride === 0) {
        const lineName = g.names[g.line[i]], point = g.pt[i];
        L.circleMarker([lat, lon], { radius: 2.5, color: col, weight: 1, fillColor: col, fillOpacity: 0.9 })
          .bindPopup(`Line ${lineName} · pt ${point}<br>${lat.toFixed(5)}, ${lon.toFixed(5)}`)
          // Clicking a station marker opens the full-detail inspector + rings it.
          .on('click', () => { jumpMapTo(lat, lon); void inspectPoint(rtype, lineName, point); })
          .addTo(grp);
      }
    }
    flush();
    return grp;
  };
  const src = build(spsGeom.src, '#ff8c00', 'S');
  const rcv = build(spsGeom.rcv, '#3aa0e0', 'R');
  if (showR) rcv.addTo(map);
  if (showS) src.addTo(map);
  leafletLayers = { src, rcv };
  const { minX, maxX, minY, maxY } = spsGeom.bbox;
  if (isFinite(minX) && isFinite(minY) && isFinite(maxX) && isFinite(maxY)) {
    map.fitBounds([[minY, minX], [maxY, maxX]], { padding: [24, 24], maxZoom: 16 });
  }
}

function numVal(id: string): number {
  const v = parseFloat(($(id) as HTMLInputElement).value);
  return isFinite(v) ? v : 0;
}

async function runQC() {
  if (!spsSummary) {
    $('qcResults').textContent = 'Load SPS files first.';
    return;
  }
  $('qcResults').textContent = 'Running QC…';
  try {
    const rows = await api.spsQC({ srcInt: numVal('qcSrcInt'), rcvInt: numVal('qcRcvInt'), tol: numVal('qcTol') || 1, maxOff: numVal('qcMaxOff') });
    renderQC(rows);
  } catch (e) {
    $('qcResults').textContent = 'QC failed: ' + errMsg(e);
  }
}

function renderQC(rows: QCRow[]) {
  const el = $('qcResults');
  el.innerHTML = '';
  let errs = 0, warns = 0;
  for (const r of rows) {
    if (r.sev === 'error') errs++;
    else if (r.sev === 'warn') warns++;
  }
  const hdr = document.createElement('div');
  hdr.className = 'qc-hdr';
  hdr.textContent = `${errs} errors · ${warns} warnings · ${rows.length} rows`;
  el.appendChild(hdr);
  for (const r of rows.slice(0, 1000)) {
    const row = document.createElement('div');
    row.className = 'qc-row ' + r.sev;
    const sev = document.createElement('span');
    sev.className = 'qc-sev';
    sev.textContent = r.sev.toUpperCase();
    const cat = document.createElement('span');
    cat.className = 'qc-cat';
    cat.textContent = r.cat;
    const msg = document.createElement('span');
    msg.className = 'qc-msg';
    msg.textContent = r.msg;
    row.appendChild(sev);
    row.appendChild(cat);
    row.appendChild(msg);
    // Findings that carry offending coords (7 of 10 types) become clickable —
    // jump the survey grid / map to the FIRST offending point and ring it.
    const first = r.pts && r.pts.length ? r.pts[0] : null;
    if (first) {
      row.classList.add('clickable');
      row.title = 'Click to locate on the survey';
      row.addEventListener('click', () => focusPoint(first));
    }
    el.appendChild(row);
  }
}

async function exportReprojected() {
  if (!spsSummary) {
    $('spsExportStatus').textContent = 'Load SPS files first.';
    return;
  }
  const code = ($('epsgSelect') as HTMLSelectElement).value;
  $('spsExportStatus').textContent = 'Reprojecting…';
  try {
    const r = await api.spsReproject(code);
    if (r.ok) $('spsExportStatus').textContent = '✓ Saved ' + r.path;
    else if (r.canceled) $('spsExportStatus').textContent = '';
    else $('spsExportStatus').textContent = 'Failed: ' + (r.error || 'unknown');
  } catch (e) {
    $('spsExportStatus').textContent = 'Failed: ' + errMsg(e);
  }
}

// Read the current QC inputs (same fields runQC sends) so the QC-report export
// uses exactly what the user has dialed in.
function currentQCParams(): QCParamsUI {
  return { srcInt: numVal('qcSrcInt'), rcvInt: numVal('qcRcvInt'), tol: numVal('qcTol') || 1, maxOff: numVal('qcMaxOff') };
}

// Enable/disable the SPS export buttons (disabled until a survey is loaded).
function setSpsExportEnabled(on: boolean) {
  for (const id of ['spsExpKmlBtn', 'spsExpGeojsonBtn', 'spsExpCsvBtn', 'spsExpQcBtn']) {
    ($(id) as HTMLButtonElement).disabled = !on;
  }
}

// Geographic / tabular SPS export (KML, GeoJSON, CSV trio, QC-report CSV). Saves
// EXACTLY like exportReprojected: the main side runs the same ZIP / single-file
// Save flow and returns {ok, path | canceled | error}; we just surface it.
async function exportSPS(kind: 'kml' | 'geojson' | 'csv' | 'qcreport') {
  if (!spsSummary) {
    $('spsExpStatus').textContent = 'Load SPS files first.';
    return;
  }
  $('spsExpStatus').textContent = 'Exporting…';
  try {
    const r = await api.spsExport({ kind, qcParams: kind === 'qcreport' ? currentQCParams() : undefined });
    if (r.ok) $('spsExpStatus').textContent = '✓ Saved ' + r.path;
    else if (r.canceled) $('spsExpStatus').textContent = '';
    else $('spsExpStatus').textContent = 'Failed: ' + (r.error || 'unknown');
  } catch (e) {
    $('spsExpStatus').textContent = 'Failed: ' + errMsg(e);
  }
}

// ── Velocity / semblance ──
function velGeom(cv: HTMLCanvasElement) {
  return { W: cv.clientWidth || 900, H: cv.clientHeight || 460, ML: 56, MR: 12, MT: 12, MB: 28 };
}

async function computeVelocity() {
  if (!summary || summary.traceCount === 0) {
    $('velLabel').textContent = 'Open a file first.';
    return;
  }
  $('velLabel').textContent = 'Computing…';
  try {
    velResult = await api.semblance({ velMin: numVal('velMin') || 1000, velMax: numVal('velMax') || 5000, velStep: numVal('velStep') || 50 });
    $('velLabel').textContent = `${velResult.vels.length} velocities · ${velResult.offNote}`;
    drawVelocity();
  } catch (e) {
    $('velLabel').textContent = 'Failed: ' + errMsg(e);
  }
}

function drawVelocity() {
  const cv = $('velCanvas') as HTMLCanvasElement;
  const dpr = window.devicePixelRatio || 1;
  const { W, H, ML, MR, MT, MB } = velGeom(cv);
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0d1f33';
  ctx.fillRect(0, 0, W, H);
  if (!velResult) return;
  const { semb, vels, nT, dt } = velResult;
  const nV = vels.length;
  const pw = W - ML - MR;
  const ph = H - MT - MB;

  const off = document.createElement('canvas');
  off.width = nV;
  off.height = nT;
  const octx = off.getContext('2d')!;
  const img = octx.createImageData(nV, nT);
  for (let vi = 0; vi < nV; vi++) {
    for (let ti = 0; ti < nT; ti++) {
      const [r, g, b] = getColor(Math.max(0, Math.min(1, semb[vi * nT + ti])) * 2 - 1, 'viridis');
      const idx = (ti * nV + vi) * 4;
      img.data[idx] = r;
      img.data[idx + 1] = g;
      img.data[idx + 2] = b;
      img.data[idx + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, ML, MT, pw, ph);

  const velMin = vels[0];
  const velMax = vels[nV - 1];
  const totalMs = nT * dt * 1000;
  ctx.strokeStyle = '#ff5d6c';
  ctx.lineWidth = 1.5;
  for (const p of velPicks) {
    const x = ML + ((p.v - velMin) / (velMax - velMin)) * pw;
    const y = MT + (p.tMs / totalMs) * ph;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = '#7e93ac';
  ctx.font = '10px Consolas, monospace';
  ctx.fillText(`${velMin}–${velMax} m/s  (click to pick)`, ML, H - 8);
  for (let k = 0; k <= 4; k++) {
    const y = MT + (ph * k) / 4;
    ctx.fillText(((totalMs * k) / 4).toFixed(0) + ' ms', 4, y + 3);
  }
}

function onVelClick(e: MouseEvent) {
  if (!velResult) return;
  const cv = $('velCanvas') as HTMLCanvasElement;
  const rect = cv.getBoundingClientRect();
  const { ML, MR, MT, MB } = velGeom(cv);
  const W = cv.clientWidth;
  const H = cv.clientHeight;
  const pw = W - ML - MR;
  const ph = H - MT - MB;
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  if (px < ML || px > ML + pw || py < MT || py > MT + ph) return;
  const { vels, nT, dt } = velResult;
  const velMin = vels[0];
  const velMax = vels[vels.length - 1];
  const totalMs = nT * dt * 1000;
  const v = Math.round(velMin + ((px - ML) / pw) * (velMax - velMin));
  const tMs = Math.round(((py - MT) / ph) * totalMs);
  const near = velPicks.findIndex((p) => {
    const x = ML + ((p.v - velMin) / (velMax - velMin)) * pw;
    const y = MT + (p.tMs / totalMs) * ph;
    return Math.hypot(px - x, py - y) < 12;
  });
  if (near >= 0) velPicks.splice(near, 1);
  else velPicks.push({ v, tMs });
  drawVelocity();
  renderVelPicks();
}

function renderVelPicks() {
  const el = $('velPicks');
  el.innerHTML = '';
  for (const p of velPicks.slice().sort((a, b) => a.tMs - b.tMs)) {
    const row = document.createElement('div');
    row.className = 'qc-row ok';
    const a = document.createElement('span');
    a.className = 'qc-sev';
    a.textContent = p.tMs + ' ms';
    const b = document.createElement('span');
    b.className = 'qc-cat';
    b.textContent = p.v + ' m/s';
    row.appendChild(a);
    row.appendChild(b);
    row.appendChild(document.createElement('span'));
    el.appendChild(row);
  }
}

async function exportPicks() {
  if (!velPicks.length) {
    $('velLabel').textContent = 'No picks to export.';
    return;
  }
  const csv = 't_ms,v_ms\n' + velPicks.slice().sort((a, b) => a.tMs - b.tMs).map((p) => `${p.tMs},${p.v}`).join('\n') + '\n';
  try {
    const r = await api.exportText('velocity_picks.csv', csv);
    $('velLabel').textContent = r.ok ? '✓ Saved ' + r.path : r.canceled ? '' : 'Failed: ' + (r.error || 'unknown');
  } catch (e) {
    $('velLabel').textContent = 'Failed: ' + errMsg(e);
  }
}


function errMsg(e: unknown): string {
  return e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e);
}

// Wire the custom window-control buttons (frameless window) to the main process
// and keep the maximize/restore icon in sync with the real window state.
function initWindowControls() {
  $opt('winMin')?.addEventListener('click', () => api?.winMinimize?.());
  $opt('winMax')?.addEventListener('click', () => api?.winMaximizeToggle?.());
  $opt('winClose')?.addEventListener('click', () => api?.winClose?.());
  api?.onWinMaximized?.((m) => $opt('winMax')?.classList.toggle('maximized', m));
}

// ── Wire up ──
function init() {
  initTheme();
  initZoom();
  initWindowControls();
  for (const t of TABS) $(`tab-${t}`).addEventListener('click', () => switchTab(t));
  $('openBtn').addEventListener('click', onOpen);
  $('openBtn2').addEventListener('click', onOpen);

  // ── Converter: mode switcher ──
  $opt('modeSingle')?.addEventListener('click', () => setConvMode('single'));
  $opt('modeBatch')?.addEventListener('click', () => setConvMode('batch'));

  // ── Converter: format chips (both single + batch groups stay in sync) ──
  const onChip = (e: Event) => {
    const btn = (e.target as HTMLElement).closest('button[data-fmt]') as HTMLElement | null;
    if (!btn || batchRunning) return;
    selectFormat(btn.getAttribute('data-fmt')!);
  };
  $opt('fmtChips')?.addEventListener('click', onChip);
  $opt('fmtChipsBatch')?.addEventListener('click', onChip);

  // ── Converter: output-name controls (template + date → live preview) ──
  const dateEl = $opt('outNameDate') as HTMLInputElement | null;
  if (dateEl && !dateEl.value) {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    dateEl.value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  $opt('outNameTpl')?.addEventListener('input', updateNamePreview);
  $opt('outNameDate')?.addEventListener('input', updateNamePreview);

  // ── Converter: single-file ──
  $('convertBtn').addEventListener('click', onConvert);
  $opt('clearBtn')?.addEventListener('click', () => void clearConverter());

  // ── Converter: folder batch wizard ──
  $opt('pickFolderBtn')?.addEventListener('click', () => void pickBatchFolder());
  $opt('pickOutBtn')?.addEventListener('click', () => void pickBatchOut());
  $opt('runBatchBtn')?.addEventListener('click', () => void runBatch());
  $opt('cancelBatchBtn')?.addEventListener('click', cancelBatch);
  $opt('clearBatchBtn')?.addEventListener('click', () => void clearConverter());
  // live per-file progress from the backend
  convProgressOff = api.onConvertProgress(onBatchProgress);

  // ── Help / Manual modal ──
  $opt('helpBtn')?.addEventListener('click', openManual);
  $opt('railHelp')?.addEventListener('click', openManual);
  $opt('manualClose')?.addEventListener('click', closeManual);
  $opt('manualBack')?.addEventListener('click', (e) => { if (e.target === $opt('manualBack')) closeManual(); });
  const slider = $('traceSlider') as HTMLInputElement;
  slider.addEventListener('input', () => {
    traceIndex = parseInt(slider.value, 10) || 0;
    void refreshTrace();
  });
  $('tracePrev').addEventListener('click', () => {
    traceIndex--;
    void refreshTrace();
  });
  $('traceNext').addEventListener('click', () => {
    traceIndex++;
    void refreshTrace();
  });
  $('traceWave').addEventListener('click', () => setTraceMode('wave'));
  $('traceSpec').addEventListener('click', () => setTraceMode('spectrum'));
  // Trace Inspector: add the current trace to the Trace Workbench (shared add path).
  $opt('traceToWb')?.addEventListener('click', () => {
    if (!summary || !lastTrace) { $('traceLabel').textContent = 'Open a file and pick a trace first.'; return; }
    wbAddTrace(`${summary.name} #${lastTrace.index + 1}`, lastTrace.index, lastTrace.samples.slice(), lastTrace.sampleInt, lastTrace.nSamples);
    $('traceLabel').textContent = `Added trace ${lastTrace.index + 1} to Workbench`;
  });
  traceInteractions(); // wheel-zoom / drag-pan / dblclick-fit + toolbar on the trace TIME axis
  for (const id of ['secMode', 'secColor']) ($(id) as HTMLSelectElement).addEventListener('change', redrawSection);
  ($('secGain') as HTMLInputElement).addEventListener('input', redrawSection);
  ($('secAgc') as HTMLInputElement).addEventListener('change', () => void refreshSection());
  sectionInteractions(); // wheel-zoom / drag-pan / dblclick-fit + toolbar on the section DATA
  // File Viewer: step to the previous/next seismic file in the open file's folder.
  $opt('filePrevBtn')?.addEventListener('click', () => void navFile(-1));
  $opt('fileNextBtn')?.addEventListener('click', () => void navFile(1));
  $('spsLoadBtn').addEventListener('click', () => void loadSPS());
  ($('spsShowS') as HTMLInputElement).addEventListener('change', () => void refreshSps());
  ($('spsShowR') as HTMLInputElement).addEventListener('change', () => void refreshSps());
  $opt('spsShowXrefs')?.addEventListener('change', () => {
    // Toggling off drops any shot emphasis; on triggers a lazy first fetch via refreshSps.
    if (!spsShowXrefs()) highlightedShot = null;
    void refreshSps();
  });
  // Fold/coverage: toggling on triggers a lazy first fetch via refreshSps.
  $opt('spsShowFold')?.addEventListener('change', () => void refreshSps());
  // Bin-size change invalidates the cached fold grid; refetch only if it's on.
  $opt('spsBinSize')?.addEventListener('change', () => {
    spsFold = null; spsFoldBin = 0;
    if (spsShowFold()) void refreshSps();
  });
  $('viewGrid').addEventListener('click', () => setView('grid'));
  $('viewMap').addEventListener('click', () => setView('map'));
  gridInteractions();
  $opt('spsInspClose')?.addEventListener('click', clearInspector);
  $('spsQcBtn').addEventListener('click', () => void runQC());
  const epsgSel = $('epsgSelect') as HTMLSelectElement;
  for (const c of EPSG_DB) {
    const o = document.createElement('option');
    o.value = c.code;
    o.textContent = `${c.code} — ${c.name}`;
    epsgSel.appendChild(o);
  }
  epsgSel.value = 'EPSG:4326';
  $('spsExportBtn').addEventListener('click', () => void exportReprojected());
  $('spsExpKmlBtn').addEventListener('click', () => void exportSPS('kml'));
  $('spsExpGeojsonBtn').addEventListener('click', () => void exportSPS('geojson'));
  $('spsExpCsvBtn').addEventListener('click', () => void exportSPS('csv'));
  $('spsExpQcBtn').addEventListener('click', () => void exportSPS('qcreport'));
  $('velComputeBtn').addEventListener('click', () => void computeVelocity());
  $('velExportBtn').addEventListener('click', () => void exportPicks());
  ($('velCanvas') as HTMLCanvasElement).addEventListener('click', onVelClick);
  workbenchInteractions(); // Trace Workbench: add/remove/clear + shared zoom/pan
  // OS-aware key hints (replaces the hard-coded ⌘ glyphs everywhere).
  applyKeyHints();

  // Global keyboard shortcuts.
  document.addEventListener('keydown', onKeyDown);

  // Ctrl/Cmd + mouse-wheel zooms the whole UI (browser-style). Non-passive so we
  // can preventDefault and stop the page from scrolling while pinch-zooming.
  window.addEventListener('wheel', (e: WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    if (e.deltaY !== 0) zoomBy(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  // Tidy the progress subscription on teardown.
  window.addEventListener('beforeunload', () => { convProgressOff?.(); });

  // Paint the empty File-summary / Header-QC / status-strip placeholders.
  clearSummaryPanel();
  renderHeaderQc();
  updateStatusStrip();
  updateFileNav();
  setConvMode('single');
  refreshWizard();
  switchTab('conv');
}

/** App-wide keyboard shortcuts. */
function onKeyDown(e: KeyboardEvent) {
  // Esc always closes the manual.
  if (e.key === 'Escape' && manualOpen()) { closeManual(); return; }
  // App-wide UI zoom (browser-style): Ctrl/Cmd + '='/'+' in, Ctrl/Cmd + '-' out,
  // Ctrl/Cmd + '0' reset. Handled before the typing-in-a-field guard so it works
  // with any element focused, just like a browser.
  if (e.ctrlKey || e.metaKey) {
    if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomBy(1); return; }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomBy(-1); return; }
    if (e.key === '0') { e.preventDefault(); zoomReset(); return; }
  }
  // Ignore when typing in a field.
  const tgt = e.target as HTMLElement | null;
  if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
  const mod = e.ctrlKey || e.metaKey;
  // '?' opens the manual (Shift+/ on most layouts).
  if (!mod && (e.key === '?' )) { e.preventDefault(); manualOpen() ? closeManual() : openManual(); return; }
  if (mod && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); void onOpen(); return; }
  if (mod && (e.key === 'b' || e.key === 'B')) { e.preventDefault(); switchTab('conv'); setConvMode('batch'); return; }
  // '[' / ']' step to the previous / next seismic file in the open file's folder.
  if (!mod && e.key === '[') { e.preventDefault(); void navFile(-1); return; }
  if (!mod && e.key === ']') { e.preventDefault(); void navFile(1); return; }
  if (!mod && e.key >= '1' && e.key <= '6') {
    const idx = parseInt(e.key, 10) - 1;
    if (idx >= 0 && idx < TABS.length) { e.preventDefault(); switchTab(TABS[idx]); }
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
