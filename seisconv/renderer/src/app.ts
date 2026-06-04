// SeisConv renderer — entry. Bundled by esbuild (platform=browser) to
// renderer/dist/app.js. Talks only to window.seisconvAPI (preload bridge);
// never touches Node/fs directly. Pure render helpers come from core.

import { normFactorPercentile } from '../../core/render/model';
import { getColor } from '../../core/render/colormaps';
import { EPSG_DB } from '../../core/sps/reproject';

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
type SpsPoints = { srcE: Float32Array; srcN: Float32Array; rcvE: Float32Array; rcvN: Float32Array };
type QCParamsUI = { srcInt?: number; rcvInt?: number; tol?: number; maxOff?: number };
type QCRow = { sev: string; cat: string; msg: string };
type BatchRow = { name: string; ok: boolean; traces?: number; error?: string };
type SemblanceData = { semb: Float32Array; vels: number[]; nT: number; dt: number; siUs: number; offNote: string };
type VelPick = { v: number; tMs: number };

declare global {
  interface Window {
    seisconvAPI: {
      openAndParse(): Promise<Summary | null>;
      getTrace(i: number): Promise<TraceData>;
      getSection(o?: SectionOpts): Promise<SectionData>;
      convert(format: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
      batchConvert(format: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string; results?: BatchRow[] } | null>;
      openSPS(): Promise<SpsSummary | null>;
      getSpsPoints(): Promise<SpsPoints>;
      spsLatLon(): Promise<{ srcLon: Float32Array; srcLat: Float32Array; rcvLon: Float32Array; rcvLat: Float32Array }>;
      spsQC(qc?: QCParamsUI): Promise<QCRow[]>;
      spsReproject(code: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
      semblance(opts: { velMin: number; velMax: number; velStep: number }): Promise<SemblanceData>;
      exportText(name: string, text: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
    };
  }
}
const api = window.seisconvAPI;
const $ = (id: string) => document.getElementById(id) as HTMLElement;

let summary: Summary | null = null;
let traceIndex = 0;
let outFormat = 'segy1';
let lastSection: SectionData | null = null;
let spsSummary: SpsSummary | null = null;
let spsPts: SpsPoints | null = null;
let spsGeoPts: SpsPoints | null = null;
let spsGeoMode = false;
let velResult: SemblanceData | null = null;
let velPicks: VelPick[] = [];

const TABS = ['conv', 'trace', 'section', 'sps', 'vel'] as const;
type Tab = (typeof TABS)[number];

function switchTab(tab: Tab) {
  for (const t of TABS) {
    $(`tab-${t}`).classList.toggle('on', t === tab);
    $(`panel-${t}`).style.display = t === tab ? '' : 'none';
  }
  if (tab === 'trace' && summary) void refreshTrace();
  if (tab === 'section' && summary) void refreshSection();
  if (tab === 'sps' && spsSummary) void refreshSpsPlot();
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

function renderInfo() {
  if (!summary) {
    $('fileInfo').style.display = 'none';
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
}

async function onOpen() {
  setStatus('convStatus', 'Opening…');
  try {
    const s = await api.openAndParse();
    if (!s) {
      setStatus('convStatus', '');
      return;
    }
    summary = s;
    traceIndex = 0;
    renderInfo();
    setStatus('convStatus', '');
    if ($('panel-trace').style.display !== 'none') void refreshTrace();
    if ($('panel-section').style.display !== 'none') void refreshSection();
  } catch (e) {
    setStatus('convStatus', 'Could not read file: ' + errMsg(e), 'err');
  }
}

// ── Converter ──
async function onConvert() {
  if (!summary) return;
  setStatus('convStatus', 'Converting…');
  ($('convertBtn') as HTMLButtonElement).disabled = true;
  try {
    const r = await api.convert(outFormat);
    if (r.ok) setStatus('convStatus', '✓ Saved ' + r.path, 'ok');
    else if (r.canceled) setStatus('convStatus', '');
    else setStatus('convStatus', 'Conversion failed: ' + (r.error || 'unknown'), 'err');
  } catch (e) {
    setStatus('convStatus', 'Conversion failed: ' + errMsg(e), 'err');
  } finally {
    ($('convertBtn') as HTMLButtonElement).disabled = !(summary && summary.traceCount > 0);
  }
}

async function batchConvert() {
  setStatus('convStatus', 'Pick files to convert…');
  try {
    const r = await api.batchConvert(outFormat);
    if (!r) {
      setStatus('convStatus', '');
      return;
    }
    renderBatchResults(r.results);
    if (r.ok) setStatus('convStatus', '✓ Saved ' + r.path, 'ok');
    else if (r.canceled) setStatus('convStatus', 'Converted — save cancelled');
    else setStatus('convStatus', 'Batch failed: ' + (r.error || 'unknown'), 'err');
  } catch (e) {
    setStatus('convStatus', 'Batch failed: ' + errMsg(e), 'err');
  }
}

function renderBatchResults(results?: BatchRow[]) {
  const el = $('batchResults');
  el.innerHTML = '';
  if (!results || !results.length) return;
  const ok = results.filter((r) => r.ok).length;
  const hdr = document.createElement('div');
  hdr.className = 'qc-hdr';
  hdr.textContent = `${ok}/${results.length} converted`;
  el.appendChild(hdr);
  for (const r of results) {
    const row = document.createElement('div');
    row.className = 'qc-row ' + (r.ok ? 'ok' : 'error');
    const sev = document.createElement('span');
    sev.className = 'qc-sev';
    sev.textContent = r.ok ? 'OK' : 'ERR';
    const cat = document.createElement('span');
    cat.className = 'qc-cat';
    cat.textContent = r.ok ? `${r.traces ?? 0} tr` : '';
    const msg = document.createElement('span');
    msg.className = 'qc-msg';
    msg.textContent = r.ok ? r.name : `${r.name}: ${r.error || 'failed'}`;
    row.appendChild(sev);
    row.appendChild(cat);
    row.appendChild(msg);
    el.appendChild(row);
  }
}

// ── Trace Inspector ──
async function refreshTrace() {
  if (!summary || summary.traceCount === 0) return;
  traceIndex = Math.max(0, Math.min(summary.traceCount - 1, traceIndex));
  try {
    const t = await api.getTrace(traceIndex);
    drawTrace($('traceCanvas') as HTMLCanvasElement, t);
    $('traceLabel').textContent = `Trace ${t.index + 1} / ${summary.traceCount}  ·  ${t.nSamples} samples`;
    ($('traceSlider') as HTMLInputElement).max = String(summary.traceCount - 1);
    ($('traceSlider') as HTMLInputElement).value = String(traceIndex);
  } catch (e) {
    $('traceLabel').textContent = 'Trace read failed: ' + errMsg(e);
  }
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

// ── SPS 2.1 (survey points) ──
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
    spsPts = await api.getSpsPoints();
    spsGeoPts = null;
    spsGeoMode = false;
    ($('spsGeo') as HTMLInputElement).checked = false;
    $('spsLabel').textContent = spsLabel(s);
    drawSurveyPlot($('spsCanvas') as HTMLCanvasElement);
  } catch (e) {
    $('spsLabel').textContent = 'SPS load failed: ' + errMsg(e);
  }
}

async function refreshSpsPlot() {
  if (!spsSummary) return;
  if (!spsPts) {
    try {
      spsPts = await api.getSpsPoints();
    } catch {
      return;
    }
  }
  drawSurveyPlot($('spsCanvas') as HTMLCanvasElement);
}

function drawSurveyPlot(cv: HTMLCanvasElement) {
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 900;
  const H = cv.clientHeight || 500;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0d1f33';
  ctx.fillRect(0, 0, W, H);
  const pts = spsGeoMode && spsGeoPts ? spsGeoPts : spsPts;
  if (!pts) return;
  const showS = ($('spsShowS') as HTMLInputElement).checked;
  const showR = ($('spsShowR') as HTMLInputElement).checked;

  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity, count = 0;
  const acc = (E: Float32Array, N: Float32Array) => {
    for (let i = 0; i < E.length; i++) {
      const e = E[i], n = N[i];
      if (!isFinite(e) || !isFinite(n)) continue;
      count++;
      if (e < minE) minE = e;
      if (e > maxE) maxE = e;
      if (n < minN) minN = n;
      if (n > maxN) maxN = n;
    }
  };
  if (showS) acc(pts.srcE, pts.srcN);
  if (showR) acc(pts.rcvE, pts.rcvN);
  if (!count) return;
  if (maxE <= minE) maxE = minE + 1;
  if (maxN <= minN) maxN = minN + 1;

  const ML = 64, MR = 16, MT = 16, MB = 28;
  const pw = W - ML - MR;
  const ph = H - MT - MB;
  const sc = Math.min(pw / (maxE - minE), ph / (maxN - minN));
  const ox = ML + (pw - sc * (maxE - minE)) / 2;
  const oy = MT + (ph - sc * (maxN - minN)) / 2;
  const X = (e: number) => ox + (e - minE) * sc;
  const Yf = (n: number) => oy + (maxN - n) * sc;

  const plot = (E: Float32Array, N: Float32Array, col: string) => {
    ctx.fillStyle = col;
    for (let i = 0; i < E.length; i++) {
      const e = E[i], n = N[i];
      if (!isFinite(e) || !isFinite(n)) continue;
      ctx.fillRect(X(e) - 1, Yf(n) - 1, 2.2, 2.2);
    }
  };
  if (showR) plot(pts.rcvE, pts.rcvN, '#3aa0e0');
  if (showS) plot(pts.srcE, pts.srcN, '#ff5d6c');

  ctx.strokeStyle = '#214564';
  ctx.lineWidth = 1;
  ctx.strokeRect(ML, MT, pw, ph);
  ctx.fillStyle = '#7e93ac';
  ctx.font = '10px Consolas, monospace';
  const geo = spsGeoMode && spsGeoPts != null;
  const pr = geo ? 4 : 0;
  ctx.fillText(`${geo ? 'lon' : 'E'} ${minE.toFixed(pr)}–${maxE.toFixed(pr)} · ${geo ? 'lat' : 'N'} ${minN.toFixed(pr)}–${maxN.toFixed(pr)}  (● src  ● rcv)`, ML + 4, H - 8);
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

async function toggleGeo() {
  spsGeoMode = ($('spsGeo') as HTMLInputElement).checked;
  if (spsGeoMode && spsSummary && !spsGeoPts) {
    try {
      const g = await api.spsLatLon();
      spsGeoPts = { srcE: g.srcLon, srcN: g.srcLat, rcvE: g.rcvLon, rcvN: g.rcvLat };
    } catch (e) {
      $('spsLabel').textContent = 'Geographic view failed: ' + errMsg(e);
      spsGeoMode = false;
      ($('spsGeo') as HTMLInputElement).checked = false;
    }
  }
  drawSurveyPlot($('spsCanvas') as HTMLCanvasElement);
}

function errMsg(e: unknown): string {
  return e && typeof e === 'object' && 'message' in e ? String((e as { message: unknown }).message) : String(e);
}

// ── Wire up ──
function init() {
  for (const t of TABS) $(`tab-${t}`).addEventListener('click', () => switchTab(t));
  $('openBtn').addEventListener('click', onOpen);
  $('openBtn2').addEventListener('click', onOpen);
  $('convertBtn').addEventListener('click', onConvert);
  $('batchBtn').addEventListener('click', () => void batchConvert());
  $('fmtChips').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-fmt]') as HTMLElement | null;
    if (!btn) return;
    outFormat = btn.getAttribute('data-fmt')!;
    for (const b of $('fmtChips').querySelectorAll('button')) b.classList.toggle('sel', b === btn);
  });
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
  for (const id of ['secMode', 'secColor']) ($(id) as HTMLSelectElement).addEventListener('change', redrawSection);
  ($('secGain') as HTMLInputElement).addEventListener('input', redrawSection);
  ($('secAgc') as HTMLInputElement).addEventListener('change', () => void refreshSection());
  $('spsLoadBtn').addEventListener('click', () => void loadSPS());
  ($('spsShowS') as HTMLInputElement).addEventListener('change', () => { if (spsPts) drawSurveyPlot($('spsCanvas') as HTMLCanvasElement); });
  ($('spsShowR') as HTMLInputElement).addEventListener('change', () => { if (spsPts) drawSurveyPlot($('spsCanvas') as HTMLCanvasElement); });
  ($('spsGeo') as HTMLInputElement).addEventListener('change', () => void toggleGeo());
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
  switchTab('conv');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
