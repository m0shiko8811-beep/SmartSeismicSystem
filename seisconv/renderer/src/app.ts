// SeisConv renderer — entry. Bundled by esbuild (platform=browser) to
// renderer/dist/app.js. Talks only to window.seisconvAPI (preload bridge);
// never touches Node/fs directly. Pure render helpers come from core.

import { normFactorPercentile } from '../../core/render/model';
import { getColor } from '../../core/render/colormaps';
import { EPSG_DB } from '../../core/sps/reproject';
import { amplitudeSpectrum } from '../../core/dsp/fft';
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
};
type TraceData = { index: number; nSamples: number; sampleInt: number; hdr: Record<string, number | string>; samples: Float32Array };
type SectionOpts = { maxTraces?: number; maxSamples?: number; agc?: boolean; agcType?: 'rms' | 'median' | 'mean'; agcWindowMs?: number };
type SectionData = { numTraces: number; colLen: number; norm: number; sampleInt: number; traceStep: number; data: Float32Array };
type SpsSummary = { sources: number; receivers: number; xrefs: number; layout: string | null; projection: { type: string | null; subtype: string | null; desc?: string } | null; errors: string[] };
type SpsLines = { x: Float32Array; y: Float32Array; line: Int32Array; pt: Float32Array; names: string[] };
type SpsGeometry = { geo: boolean; src: SpsLines; rcv: SpsLines; bbox: { minX: number; maxX: number; minY: number; maxY: number } };
type QCParamsUI = { srcInt?: number; rcvInt?: number; tol?: number; maxOff?: number };
type QCRow = { sev: string; cat: string; msg: string };
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
      getTrace(i: number): Promise<TraceData>;
      getSection(o?: SectionOpts): Promise<SectionData>;
      // Single-file conversion of the currently-open file (save dialog).
      // `outBaseName` (no extension) becomes the dialog's default file name.
      convertSingle(format: string, outBaseName?: string): Promise<ConvResult>;
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
      spsQC(qc?: QCParamsUI): Promise<QCRow[]>;
      spsReproject(code: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
      semblance(opts: { velMin: number; velMax: number; velStep: number }): Promise<SemblanceData>;
      exportText(name: string, text: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
      // Recolor the native window-controls overlay (min/max/close) to match the theme.
      setTitleBarOverlay(opts: { color: string; symbolColor: string }): Promise<void>;
    };
  }
}
const api = window.seisconvAPI;
const $ = (id: string) => document.getElementById(id) as HTMLElement;
/** Optional lookup — returns null instead of throwing when an id is absent. */
const $opt = (id: string) => document.getElementById(id);

// ── Theme (GUI C: light default + working dark toggle, persisted) ──
type Theme = 'light' | 'dark';
// Native window-controls overlay (min/max/close) colors per theme. `color` is
// an OPAQUE equivalent of the header background (--header-bg is translucent over
// --canvas); `symbolColor` matches the header glyph color (--ink). Keep these in
// sync with the BrowserWindow `titleBarOverlay` defaults in electron/main.ts.
const TITLEBAR_OVERLAY: Record<Theme, { color: string; symbolColor: string }> = {
  light: { color: '#f3f6fb', symbolColor: '#15212f' }, // light header bg + dark glyphs
  dark: { color: '#102438', symbolColor: '#e8eef6' },  // navy header bg + light glyphs
};
function applyTheme(t: Theme) {
  document.documentElement.setAttribute('data-theme', t);
  $opt('themeLight')?.classList.toggle('on', t === 'light');
  $opt('themeDark')?.classList.toggle('on', t === 'dark');
  // Keep the native min/max/close overlay matching the header in this theme.
  try { void api?.setTitleBarOverlay?.(TITLEBAR_OVERLAY[t]); } catch { /* ignore */ }
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
      `<span class="kbd">1–5</span> switch tabs · ` +
      `<span class="kbd">?</span> help.`;
  }
  // rail + header tooltips
  $opt('railHelp')?.setAttribute('title', `Help / Manual — keys: ${KEY_OPEN} open · ${KEY_BATCH} batch · 1–5 tabs · ? help`);
  $opt('helpBtn')?.setAttribute('title', `Help / Manual (?)`);
  $opt('openBtn')?.setAttribute('title', `Open a seismic file (${KEY_OPEN})`);
  // in-manual key chips that carry a data-key marker
  document.querySelectorAll<HTMLElement>('.kbd[data-key]').forEach((el) => {
    const k = el.getAttribute('data-key');
    if (k === 'open') el.textContent = KEY_OPEN;
    else if (k === 'batch') el.textContent = KEY_BATCH;
    else if (k === 'tabs') el.textContent = '1–5';
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
};

let summary: Summary | null = null;
let traceIndex = 0;
let lastTrace: TraceData | null = null;
let traceMode: 'wave' | 'spectrum' = 'wave';
let outFormat = 'segy1';
let lastSection: SectionData | null = null;
let spsSummary: SpsSummary | null = null;
let spsGeom: SpsGeometry | null = null;
let spsView: 'grid' | 'map' = 'grid';
const gridView = { sc: 1, ox: 0, oy: 0, init: false }; // canvas pan/zoom: x_px = ox + e*sc, y_px = oy - n*sc
let leafletMap: L.Map | null = null;
let leafletLayers: { src: L.LayerGroup; rcv: L.LayerGroup } | null = null;
let velResult: SemblanceData | null = null;
let velPicks: VelPick[] = [];

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

const TABS = ['conv', 'trace', 'section', 'sps', 'vel'] as const;
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
    summary = s;
    traceIndex = 0;
    renderInfo();
    showSingleLoaded();      // banner + light up the single-file wizard
    updateNamePreview();
    setStatus('convStatus', '');
    setState(s.errors.length ? 'ok' : 'ok', s.errors.length ? `Loaded · ${s.errors.length} flag${s.errors.length > 1 ? 's' : ''}` : 'Loaded');
    if ($('panel-trace').style.display !== 'none') void refreshTrace();
    if ($('panel-section').style.display !== 'none') void refreshSection();
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
}

// ── Trace Inspector ──
async function refreshTrace() {
  if (!summary || summary.traceCount === 0) return;
  traceIndex = Math.max(0, Math.min(summary.traceCount - 1, traceIndex));
  try {
    lastTrace = await api.getTrace(traceIndex);
    ($('traceSlider') as HTMLInputElement).max = String(summary.traceCount - 1);
    ($('traceSlider') as HTMLInputElement).value = String(traceIndex);
    renderTrace();
  } catch (e) {
    $('traceLabel').textContent = 'Trace read failed: ' + errMsg(e);
  }
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

  const ML = 60, MR = 14, MT = 14, MB = 26;
  const pw = W - ML - MR, ph = H - MT - MB;
  const cx = ML + pw / 2;
  const nf = normFactorPercentile(t.samples, 0.95) || 1;

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
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, t.samples[i] / nf));
    const x = cx + v * (pw / 2 - 2);
    const y = MT + (i / (n - 1)) * ph;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // time axis (ms down)
  ctx.fillStyle = '#7e93ac';
  ctx.font = '10px Consolas, monospace';
  const totalMs = (n * t.sampleInt) / 1000;
  for (let k = 0; k <= 5; k++) {
    const y = MT + (ph * k) / 5;
    ctx.fillText(((totalMs * k) / 5).toFixed(0) + ' ms', 6, y + 3);
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
async function refreshSection() {
  if (!summary || summary.traceCount === 0) return;
  const agc = ($('secAgc') as HTMLInputElement).checked;
  $('secLabel').textContent = 'Rendering…';
  try {
    const sec = await api.getSection({ maxTraces: 2000, maxSamples: 2000, agc, agcType: 'rms', agcWindowMs: 250 });
    lastSection = sec;
    drawSection($('secCanvas') as HTMLCanvasElement, sec);
    $('secLabel').textContent = `${sec.numTraces} traces (step ${sec.traceStep}) · ${sec.colLen} samples`;
  } catch (e) {
    $('secLabel').textContent = 'Render failed: ' + errMsg(e);
  }
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
  const ML = 58, MR = 12, MT = 10, MB = 24;
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

  ctx.fillStyle = '#7e93ac';
  ctx.font = '10px Consolas, monospace';
  const totalMs = ((summary?.samplesTrace ?? colLen) * (summary?.sampleInt ?? sec.sampleInt)) / 1000;
  for (let k = 0; k <= 5; k++) {
    const y = MT + (ph * k) / 5;
    ctx.fillText(((totalMs * k) / 5).toFixed(0) + ' ms', 6, y + 3);
  }
}

// ── SPS 2.1 (survey geometry) ──
function spsLabel(s: SpsSummary): string {
  const proj = s.projection?.desc || s.projection?.type || s.projection?.subtype || 'unknown CRS';
  return `${s.sources} sources · ${s.receivers} receivers · ${s.xrefs} X-refs · ${s.layout || '?'} · ${proj}` + (s.errors.length ? ` · ⚠ ${s.errors.length}` : '');
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
    spsGeom = null;
    gridView.init = false;
    $('spsLabel').textContent = spsLabel(s);
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
    } catch (e) {
      $('spsLabel').textContent = 'SPS geometry failed: ' + errMsg(e);
      return;
    }
  }
  if (spsView === 'grid') drawSurveyGrid();
  else updateMap();
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

  // legend
  ctx.font = '11px "Segoe UI", sans-serif';
  let lx = 52; const ly = 20;
  const legend = (col: string, txt: string) => {
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(lx, ly, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#c8d2e0'; ctx.fillText(txt, lx + 9, ly + 4); lx += ctx.measureText(txt).width + 34;
  };
  if (showS) legend('#ff8c00', `${spsSummary?.sources ?? 0} sources`);
  if (showR) legend('#3aa0e0', `${spsSummary?.receivers ?? 0} receivers`);

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

/** Attach wheel-zoom / drag-pan / hover to the grid canvas (once, at init). */
function gridInteractions() {
  const cv = $('spsCanvas') as HTMLCanvasElement;
  let dragging = false, lx = 0, ly = 0;
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
  cv.addEventListener('mousedown', (e) => { if (spsView !== 'grid') return; dragging = true; lx = e.clientX; ly = e.clientY; });
  window.addEventListener('mouseup', () => { dragging = false; });
  cv.addEventListener('mousemove', (e) => {
    if (spsView !== 'grid' || !spsGeom) return;
    if (dragging) {
      gridView.ox += e.clientX - lx; gridView.oy += e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      drawSurveyGrid();
    } else {
      hoverGrid(e);
    }
  });
  cv.addEventListener('dblclick', () => { if (spsView === 'grid' && spsGeom) { gridFit(); drawSurveyGrid(); } });
  // Keep the active SPS view correct after a window resize (the cached grid
  // transform would otherwise go stale; Leaflet needs invalidateSize).
  window.addEventListener('resize', () => {
    if (spsView === 'grid' && spsGeom) { gridFit(); drawSurveyGrid(); }
    else if (spsView === 'map' && leafletMap) leafletMap.invalidateSize();
  });
}

function hoverGrid(e: MouseEvent) {
  if (!spsGeom || !gridView.init) return;
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
  if (bg && bi >= 0) {
    const g: SpsLines = bg;
    const pr = spsGeom.geo ? 5 : 1;
    $('spsLabel').textContent = `Line ${g.names[g.line[bi]]} · pt ${g.pt[bi]} · ${g.x[bi].toFixed(pr)}, ${g.y[bi].toFixed(pr)}`;
  } else if (spsSummary) {
    $('spsLabel').textContent = spsLabel(spsSummary);
  }
}

// ── Real basemap (Leaflet, geographic) ──
function ensureMap() {
  if (leafletMap) return;
  const dark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap, © CARTO' });
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Esri World Imagery' });
  const streets = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });
  leafletMap = L.map('spsMap', { layers: [dark], preferCanvas: true });
  L.control.layers({ Dark: dark, Satellite: sat, Streets: streets }).addTo(leafletMap);
  leafletMap.setView([32, 35], 6);
}

function updateMap() {
  if (!spsGeom || !spsGeom.geo) return;
  ensureMap();
  const map = leafletMap!;
  map.invalidateSize();
  if (leafletLayers) { map.removeLayer(leafletLayers.src); map.removeLayer(leafletLayers.rcv); leafletLayers = null; }
  const showS = ($('spsShowS') as HTMLInputElement).checked;
  const showR = ($('spsShowR') as HTMLInputElement).checked;
  // Lines always draw in full; station markers are decimated so a 50k-point
  // survey can't flood the map renderer (each marker is a canvas circle + popup).
  const MAX_MARKERS = 6000;
  const build = (g: SpsLines, col: string) => {
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
        L.circleMarker([lat, lon], { radius: 2.5, color: col, weight: 1, fillColor: col, fillOpacity: 0.9 })
          .bindPopup(`Line ${g.names[g.line[i]]} · pt ${g.pt[i]}<br>${lat.toFixed(5)}, ${lon.toFixed(5)}`)
          .addTo(grp);
      }
    }
    flush();
    return grp;
  };
  const src = build(spsGeom.src, '#ff8c00');
  const rcv = build(spsGeom.rcv, '#3aa0e0');
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

// ── Wire up ──
function init() {
  initTheme();
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
  for (const id of ['secMode', 'secColor']) ($(id) as HTMLSelectElement).addEventListener('change', redrawSection);
  ($('secGain') as HTMLInputElement).addEventListener('input', redrawSection);
  ($('secAgc') as HTMLInputElement).addEventListener('change', () => void refreshSection());
  $('spsLoadBtn').addEventListener('click', () => void loadSPS());
  ($('spsShowS') as HTMLInputElement).addEventListener('change', () => void refreshSps());
  ($('spsShowR') as HTMLInputElement).addEventListener('change', () => void refreshSps());
  $('viewGrid').addEventListener('click', () => setView('grid'));
  $('viewMap').addEventListener('click', () => setView('map'));
  gridInteractions();
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
  $('velComputeBtn').addEventListener('click', () => void computeVelocity());
  $('velExportBtn').addEventListener('click', () => void exportPicks());
  ($('velCanvas') as HTMLCanvasElement).addEventListener('click', onVelClick);
  // OS-aware key hints (replaces the hard-coded ⌘ glyphs everywhere).
  applyKeyHints();

  // Global keyboard shortcuts.
  document.addEventListener('keydown', onKeyDown);

  // Tidy the progress subscription on teardown.
  window.addEventListener('beforeunload', () => { convProgressOff?.(); });

  // Paint the empty File-summary / Header-QC / status-strip placeholders.
  clearSummaryPanel();
  renderHeaderQc();
  updateStatusStrip();
  setConvMode('single');
  refreshWizard();
  switchTab('conv');
}

/** App-wide keyboard shortcuts. */
function onKeyDown(e: KeyboardEvent) {
  // Esc always closes the manual.
  if (e.key === 'Escape' && manualOpen()) { closeManual(); return; }
  // Ignore when typing in a field.
  const tgt = e.target as HTMLElement | null;
  if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
  const mod = e.ctrlKey || e.metaKey;
  // '?' opens the manual (Shift+/ on most layouts).
  if (!mod && (e.key === '?' )) { e.preventDefault(); manualOpen() ? closeManual() : openManual(); return; }
  if (mod && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); void onOpen(); return; }
  if (mod && (e.key === 'b' || e.key === 'B')) { e.preventDefault(); switchTab('conv'); setConvMode('batch'); return; }
  if (!mod && e.key >= '1' && e.key <= '5') {
    const idx = parseInt(e.key, 10) - 1;
    if (idx >= 0 && idx < TABS.length) { e.preventDefault(); switchTab(TABS[idx]); }
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
