// SeisConv renderer — vanilla JS, no framework.
//
// Talks only to window.seisconvAPI (exposed by the preload bridge). It never
// touches the filesystem or Node directly; parsing/conversion happen in the main
// process's worker thread.

'use strict';

const $ = (id) => document.getElementById(id);

let current = null; // last parsed file's { path, name, ... }
let outFormat = 'segy1';

function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function setStatus(msg, kind) {
  const el = $('status');
  el.textContent = msg || '';
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function showSummary(s) {
  current = s;
  $('infoCard').style.display = 'block';
  $('fileName').textContent = s.name;
  $('vFormat').textContent = s.format + (s.revision ? ' Rev ' + s.revision : '');
  $('vTraces').textContent = String(s.traceCount);
  $('vSamples').textContent = s.samplesTrace != null ? String(s.samplesTrace) : '—';
  $('vRate').textContent = s.sampleInt != null ? (s.sampleInt / 1000).toFixed(3) + ' ms (' + s.sampleInt + ' µs)' : '—';
  const warn = Array.isArray(s.errors) ? s.errors : [];
  $('warnRow').style.display = warn.length ? 'flex' : 'none';
  $('vWarn').textContent = warn.length ? (warn.length === 1 ? warn[0] : warn.length + ' issues') : '';
  $('convertBtn').disabled = !(s.traceCount > 0);
  setStatus('');
}

$('openBtn').addEventListener('click', async () => {
  setStatus('Opening…');
  try {
    const s = await window.seisconvAPI.openAndParse();
    if (!s) { setStatus(''); return; }
    showSummary(s);
  } catch (e) {
    setStatus('Could not read file: ' + (e && e.message ? e.message : e), 'err');
  }
});

$('fmtChips').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-fmt]');
  if (!btn) return;
  outFormat = btn.getAttribute('data-fmt');
  for (const b of $('fmtChips').querySelectorAll('button')) b.classList.toggle('sel', b === btn);
});

$('convertBtn').addEventListener('click', async () => {
  if (!current) return;
  setStatus('Converting…');
  $('convertBtn').disabled = true;
  try {
    const res = await window.seisconvAPI.convert(current.path, outFormat);
    if (res.ok) setStatus('✓ Saved ' + res.path, 'ok');
    else if (res.canceled) setStatus('');
    else setStatus('Conversion failed: ' + (res.error || 'unknown'), 'err');
  } catch (e) {
    setStatus('Conversion failed: ' + (e && e.message ? e.message : e), 'err');
  } finally {
    $('convertBtn').disabled = false;
  }
});
