// SeisConv renderer — entry. Bundled by esbuild (platform=browser) to
// renderer/dist/app.js. Talks only to window.seisconvAPI (preload bridge);
// never touches Node/fs directly. Pure render helpers come from core.

import { normFactorPercentile } from '../../core/render/model';

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

declare global {
  interface Window {
    seisconvAPI: {
      openAndParse(): Promise<Summary | null>;
      getTrace(i: number): Promise<TraceData>;
      getSection(o?: unknown): Promise<unknown>;
      convert(format: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
    };
  }
}
const api = window.seisconvAPI;
const $ = (id: string) => document.getElementById(id) as HTMLElement;

let summary: Summary | null = null;
let traceIndex = 0;
let outFormat = 'segy1';

const TABS = ['conv', 'trace', 'section', 'sps'] as const;
type Tab = (typeof TABS)[number];

function switchTab(tab: Tab) {
  for (const t of TABS) {
    $(`tab-${t}`).classList.toggle('on', t === tab);
    $(`panel-${t}`).style.display = t === tab ? '' : 'none';
  }
  if (tab === 'trace' && summary) void refreshTrace();
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
  ctx.fillStyle = '#0d0f14';
  ctx.fillRect(0, 0, W, H);
  const n = t.nSamples;
  if (!n || !t.samples.length) return;

  const ML = 60, MR = 14, MT = 14, MB = 26;
  const pw = W - ML - MR, ph = H - MT - MB;
  const cx = ML + pw / 2;
  const nf = normFactorPercentile(t.samples, 0.95) || 1;

  ctx.strokeStyle = '#222838';
  ctx.lineWidth = 1;
  ctx.strokeRect(ML, MT, pw, ph);
  ctx.beginPath();
  ctx.moveTo(cx, MT);
  ctx.lineTo(cx, MT + ph);
  ctx.strokeStyle = '#2a3142';
  ctx.stroke();

  ctx.beginPath();
  ctx.strokeStyle = '#00ff9f';
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
  ctx.fillStyle = '#7a8090';
  ctx.font = '10px Consolas, monospace';
  const totalMs = (n * t.sampleInt) / 1000;
  for (let k = 0; k <= 5; k++) {
    const y = MT + (ph * k) / 5;
    ctx.fillText(((totalMs * k) / 5).toFixed(0) + ' ms', 6, y + 3);
    ctx.strokeStyle = '#161b26';
    ctx.beginPath();
    ctx.moveTo(ML, y);
    ctx.lineTo(ML + pw, y);
    ctx.stroke();
  }
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
  switchTab('conv');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
