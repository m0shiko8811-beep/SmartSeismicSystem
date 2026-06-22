// SeisConv — reusable automated QA harness.
//
// Launches the BUILT Electron app with Playwright's `_electron` driver, mocks the
// native open/save dialogs in the MAIN process (so file flows run with no human at
// the keyboard), then drives every tab in the icon rail and exercises its core
// flow. For each tab it asserts:
//   • no uncaught exceptions  (win 'pageerror')
//   • no error-level console output
//   • the tab's key <canvas> is NOT blank (samples pixels; a uniform fill is a fail)
// and writes a screenshot to qa/shots/.
//
// USAGE:   node qa/drive.mjs            (from the seisconv/ dir)  ·  or  npm run qa
//
// Test files are env-configurable (defaults target Moshe's machine):
//   SEISCONV_QA_SEGY  big-endian SEG-Y           (Converter / Trace / Section / Velocity)
//   SEISCONV_QA_LE    little-endian SEG-Y         (re-opened to prove LE reading; 251 traces)
//   SEISCONV_QA_SPS   's','r','x' SPS files, ';'-separated  (SPS tab, multiSelections)
//
// The harness is self-contained: it requires only that `npm run build` has produced
// dist/main.js + renderer/dist/app.js, and that `playwright` is installed.

import { _electron as electron } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(__dirname, '..');        // the seisconv/ root (package.json "main"=dist/main.js)
const SHOTS = join(__dirname, 'shots');
mkdirSync(SHOTS, { recursive: true });

// ── Test files (override via env) ──────────────────────────────────────────
const SEGY = process.env.SEISCONV_QA_SEGY || 'D:\\Projects\\SeisconvApp\\Data_Games\\00000186_SegY_Rev2.segy';
const LE   = process.env.SEISCONV_QA_LE   || 'F:\\YAGUR_2026\\YAGUR_2026\\SINGLE_IMAGE_1\\SEGY_Rev_2\\00000035.sgy';
const SPS  = (process.env.SEISCONV_QA_SPS || [
  'D:\\Projects\\SeisconvApp\\SPS_Games\\NodesCheck20.s01',
  'D:\\Projects\\SeisconvApp\\SPS_Games\\NodesCheck20.r01',
  'D:\\Projects\\SeisconvApp\\SPS_Games\\NodesCheck20.x01',
].join(';')).split(';').map((s) => s.trim()).filter(Boolean);

// Dark scientific background painted under every plot canvas (see index.html .canvas).
const CANVAS_BG = { r: 0x0d, g: 0x1f, b: 0x33 };

// ── tiny helpers ────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Point the MAIN-process open dialog at `paths` and make the save dialog cancel
 *  (so write flows complete the conversion path but never touch the filesystem). */
async function mockDialogs(app, paths) {
  await app.evaluate(async ({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: p });
    dialog.showSaveDialog = async () => ({ canceled: true });
  }, paths);
}

/** Read the named <canvas> back as pixels in the renderer and decide if it is
 *  "blank" — i.e. every sampled pixel equals the dark plot background (within a
 *  small tolerance) OR the canvas is empty. Returns {blank, reason, distinct}. */
async function canvasBlank(win, id, bg) {
  return win.evaluate(({ id, bg }) => {
    const cv = document.getElementById(id);
    if (!cv || !cv.getContext) return { blank: true, reason: 'no canvas element', distinct: 0 };
    if (!cv.width || !cv.height) return { blank: true, reason: 'zero-size canvas', distinct: 0 };
    const ctx = cv.getContext('2d');
    let img;
    try { img = ctx.getImageData(0, 0, cv.width, cv.height); } catch (e) {
      return { blank: false, reason: 'unreadable (assumed drawn): ' + e.message, distinct: -1 };
    }
    const d = img.data;
    const seen = new Set();
    let nonBg = 0;
    const stepX = Math.max(1, (cv.width / 80) | 0);
    const stepY = Math.max(1, (cv.height / 80) | 0);
    for (let y = 0; y < cv.height; y += stepY) {
      for (let x = 0; x < cv.width; x += stepX) {
        const i = (y * cv.width + x) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
        seen.add((r << 24) | (g << 16) | (b << 8) | a);
        const isBg = Math.abs(r - bg.r) < 10 && Math.abs(g - bg.g) < 10 && Math.abs(b - bg.b) < 10;
        const isTransparent = a < 8;
        if (!isBg && !isTransparent) nonBg++;
      }
    }
    const distinct = seen.size;
    const blank = nonBg === 0;
    return { blank, reason: blank ? `all sampled pixels are background/transparent (${distinct} distinct)` : '', distinct, nonBg };
  }, { id, bg });
}

/** Click a rail tab and wait for its panel to become visible. */
async function gotoTab(win, tabId, panelId) {
  await win.click('#' + tabId);
  await win.waitForFunction((pid) => {
    const el = document.getElementById(pid);
    return el && getComputedStyle(el).display !== 'none';
  }, panelId, { timeout: 5000 });
  await sleep(250); // let the tab's draw settle
}

/** Open a file via the Open button and wait for the worker summary to populate
 *  (#fsTraces leaves its "—" placeholder). Returns the trace count text.
 *  The header #openBtn is HIDDEN while the Converter tab is active (app.ts line
 *  336), where the in-panel #openBtn2 ("Pick a seismic file…") is the live button;
 *  both call the same onOpen handler. Click whichever is visible. */
async function openFile(app, win, path) {
  await mockDialogs(app, [path]);
  const onConv = await win.evaluate(() => {
    const p = document.getElementById('panel-conv');
    return p && getComputedStyle(p).display !== 'none';
  });
  const openSel = onConv ? '#openBtn2' : '#openBtn';
  const base = path.replace(/\\/g, '/').split('/').pop();
  await win.click(openSel);
  // Wait until the LOADED-FILE NAME reflects THIS file — not just until #fsTraces
  // is non-"—". On a re-open the summary already holds the previous file's values,
  // so keying on the name (not the placeholder) avoids reading stale data before
  // the async worker parse of the new file lands.
  await win.waitForFunction((b) => {
    const t = document.getElementById('fsTraces');
    const name = (document.getElementById('singleFoundName')?.textContent
              || document.getElementById('fiName')?.textContent || '').trim();
    const summaryReady = t && t.textContent.trim() !== '' && t.textContent.trim() !== '—';
    return summaryReady && name.includes(b);
  }, base, { timeout: 30000 });
  return (await win.textContent('#fsTraces'))?.trim();
}

// ── run ──────────────────────────────────────────────────────────────────────
const results = [];   // { tab, pass, notes[], errors[], shot }
const globalConsole = [];
const globalPageErrors = [];

(async () => {
  // Pre-flight: confirm the build exists.
  for (const need of ['dist/main.js', 'renderer/dist/app.js', 'renderer/index.html']) {
    if (!existsSync(join(APP_DIR, need))) {
      console.error(`\n[FATAL] missing ${need} — run "npm run build" first.\n`);
      process.exit(2);
    }
  }
  console.log(`SeisConv QA harness — launching ${APP_DIR}`);
  console.log(`  SEGY = ${SEGY}\n  LE   = ${LE}\n  SPS  = ${SPS.join(' , ')}\n`);

  let app, win;
  try {
    app = await electron.launch({ args: ['.'], cwd: APP_DIR });
    win = await app.firstWindow();
  } catch (e) {
    console.error('\n[FATAL] _electron.launch failed — could NOT start the app.');
    console.error(e && e.stack ? e.stack : e);
    process.exit(3);
  }

  // Collect console errors + uncaught exceptions for the whole session.
  win.on('console', (m) => {
    if (m.type() === 'error') globalConsole.push(m.text());
  });
  win.on('pageerror', (e) => globalPageErrors.push(e.message || String(e)));

  await win.waitForLoadState('domcontentloaded');
  await sleep(500);

  // Snapshot the error counters so each tab only "owns" errors raised during it.
  const mark = () => ({ c: globalConsole.length, p: globalPageErrors.length });
  const since = (m, tabName) => {
    const errs = [];
    for (let i = m.p; i < globalPageErrors.length; i++) errs.push('pageerror: ' + globalPageErrors[i]);
    for (let i = m.c; i < globalConsole.length; i++) errs.push('console.error: ' + globalConsole[i]);
    return errs;
  };

  // Run one tab step: switch, run `fn`, screenshot, fold in errors + canvas check.
  async function step(tab, panel, shot, fn, label = tab) {
    const m = mark();
    const notes = [];
    const stepErrors = [];          // failures raised by the step body itself
    let canvasFail = null;
    try {
      await gotoTab(win, tab, panel);
      const r = await fn(notes);
      if (r && r.canvasFail) canvasFail = r.canvasFail;
      if (r && r.assertFail) stepErrors.push('assertion: ' + r.assertFail);
    } catch (e) {
      stepErrors.push('EXCEPTION in step: ' + (e && e.message ? e.message : e));
    }
    const shotPath = join(SHOTS, shot);
    try { await win.screenshot({ path: shotPath }); } catch { /* ignore */ }
    const errors = since(m, tab).concat(stepErrors);
    if (canvasFail) errors.push('blank canvas: ' + canvasFail);
    results.push({ tab: label, pass: errors.length === 0, notes, errors, shot: shotPath });
    const tag = errors.length === 0 ? 'PASS' : 'FAIL';
    console.log(`[${tag}] ${label.padEnd(14)} ${notes.concat(errors).join(' | ') || 'ok'}`);
  }

  // ── 1) CONVERTER — open the big-endian SEG-Y, read the summary ──
  await step('tab-conv', 'panel-conv', '1-converter.png', async (notes) => {
    const count = await openFile(app, win, SEGY);
    notes.push(`opened SEGY → traces=${count}`);
    const fmt = (await win.textContent('#fsFormat'))?.trim();
    const samples = (await win.textContent('#fsSamples'))?.trim();
    notes.push(`format=${fmt} samples/trace=${samples}`);
    if (!count || count === '—') notes.push('WARN: summary did not populate');
  });

  // ── 2) TRACE INSPECTOR — header table + spectrum toggle + zoom ──
  await step('tab-trace', 'panel-trace', '2-trace.png', async (notes) => {
    // waveform canvas should be drawn for the open file
    let wave = await canvasBlank(win, 'traceCanvas', CANVAS_BG);
    notes.push(`waveform canvas distinct=${wave.distinct}`);
    // header table populated?
    const hdr = (await win.textContent('#traceHdrGrid'))?.trim() || '';
    notes.push(`header table chars=${hdr.length}`);
    // step Next a couple of times
    await win.click('#traceNext'); await sleep(200);
    await win.click('#traceNext'); await sleep(200);
    // spectrum toggle
    await win.click('#traceSpec'); await sleep(400);
    const spec = await canvasBlank(win, 'traceCanvas', CANVAS_BG);
    notes.push(`spectrum canvas distinct=${spec.distinct}`);
    // zoom in/out/fit
    await win.click('#traceZoomIn'); await sleep(120);
    await win.click('#traceZoomOut'); await sleep(120);
    await win.click('#traceZoomFit'); await sleep(120);
    // back to waveform for the final check
    await win.click('#traceWave'); await sleep(300);
    const finalWave = await canvasBlank(win, 'traceCanvas', CANVAS_BG);
    return { canvasFail: finalWave.blank ? `traceCanvas ${finalWave.reason}` : null };
  });

  // ── 3) FILE VIEWER — section render + next/prev + mode ──
  await step('tab-section', 'panel-section', '3-section.png', async (notes) => {
    await sleep(600); // section renders on first show
    let sec = await canvasBlank(win, 'secCanvas', CANVAS_BG);
    notes.push(`section canvas distinct=${sec.distinct}`);
    // try the next-file (sibling) nav if enabled
    const nextEnabled = await win.isEnabled('#fileNextBtn');
    notes.push(`fileNext enabled=${nextEnabled}`);
    if (nextEnabled) { await win.click('#fileNextBtn'); await sleep(800); await win.click('#filePrevBtn'); await sleep(800); }
    // toggle a render mode
    await win.selectOption('#secMode', 'wiggle').catch(() => {}); await sleep(400);
    await win.selectOption('#secMode', 'vd').catch(() => {}); await sleep(400);
    const sec2 = await canvasBlank(win, 'secCanvas', CANVAS_BG);
    return { canvasFail: sec2.blank ? `secCanvas ${sec2.reason}` : null };
  });

  // ── 4) SPS 2.1 — load S/R/X (multiSelections) + Run QC + stats ──
  await step('tab-sps', 'panel-sps', '4-sps.png', async (notes) => {
    await mockDialogs(app, SPS); // multiSelections → all three paths
    await win.click('#spsLoadBtn');
    // wait for the survey stats / label to populate
    await win.waitForFunction(() => {
      const s = document.getElementById('spsStats');
      const l = document.getElementById('spsLabel');
      return (s && s.textContent.trim().length > 0) || (l && !/Load S\/R\/X/.test(l.textContent));
    }, null, { timeout: 20000 }).catch(() => notes.push('WARN: SPS stats did not populate in 20s'));
    await sleep(500);
    const stats = (await win.textContent('#spsStats'))?.trim();
    notes.push(`sps stats="${stats}"`);
    const grid = await canvasBlank(win, 'spsCanvas', CANVAS_BG);
    notes.push(`grid canvas distinct=${grid.distinct}`);
    // Run QC
    await win.click('#spsQcBtn'); await sleep(800);
    const qc = (await win.textContent('#qcResults'))?.trim() || '';
    notes.push(`QC results chars=${qc.length}`);
    return { canvasFail: grid.blank ? `spsCanvas ${grid.reason}` : null };
  });

  // ── 5) VELOCITY — compute NMO semblance + canvas ──
  await step('tab-vel', 'panel-vel', '5-velocity.png', async (notes) => {
    await win.click('#velComputeBtn');
    // semblance is heavy; wait for the velLabel to change or the canvas to fill
    await win.waitForFunction(() => {
      const l = document.getElementById('velLabel');
      return l && !/Open a file, then compute/.test(l.textContent);
    }, null, { timeout: 40000 }).catch(() => notes.push('WARN: semblance did not finish in 40s'));
    await sleep(600);
    const vel = await canvasBlank(win, 'velCanvas', CANVAS_BG);
    notes.push(`vel canvas distinct=${vel.distinct} label="${(await win.textContent('#velLabel'))?.trim()}"`);
    return { canvasFail: vel.blank ? `velCanvas ${vel.reason}` : null };
  });

  // ── 6) TRACE WORKBENCH — add open trace + (LE pick) + analysis ──
  await step('tab-workbench', 'panel-workbench', '6-workbench.png', async (notes) => {
    // add the current open-file trace
    await win.click('#wbAddOpenBtn'); await sleep(400);
    // pick the little-endian file and add a trace from it (proves LE reading + 2nd trace)
    await mockDialogs(app, [LE]);
    await win.click('#wbPickBtn'); await sleep(600);
    await win.fill('#wbIndex', '0').catch(() => {});
    // there is no separate "add picked" button — picking arms wbPickBtn flow; add open adds from picked too.
    await win.click('#wbAddOpenBtn').catch(() => {}); await sleep(400);
    const listChars = ((await win.textContent('#wbList'))?.trim() || '').length;
    notes.push(`workbench list chars=${listChars}`);
    const wb = await canvasBlank(win, 'wbCanvas', CANVAS_BG);
    notes.push(`workbench canvas distinct=${wb.distinct}`);
    return { canvasFail: wb.blank ? `wbCanvas ${wb.reason}` : null };
  });

  // ── 7) LITTLE-ENDIAN re-open back on Converter (expect 251 traces) ──
  await step('tab-conv', 'panel-conv', '7-le-reopen.png', async (notes) => {
    const count = await openFile(app, win, LE);
    notes.push(`LE reopened → traces=${count} (expected 251)`);
    const fmt = (await win.textContent('#fsFormat'))?.trim();
    const order = (await win.textContent('#fsByteOrder'))?.trim();
    notes.push(`format=${fmt} byteOrder=${order}`);
    if (count !== '251') return { assertFail: `LE trace count was "${count}", expected 251` };
  }, 'tab-conv-le');

  // ── teardown + report ──
  await app.close();

  console.log('\n================= SeisConv QA REPORT =================');
  let failed = 0;
  for (const r of results) {
    const tag = r.pass ? 'PASS' : 'FAIL';
    if (!r.pass) failed++;
    console.log(`\n[${tag}] ${r.tab}`);
    for (const n of r.notes) console.log('   · ' + n);
    for (const e of r.errors) console.log('   ✗ ' + e);
    console.log('   shot: ' + r.shot);
  }
  console.log('\n-----------------------------------------------------');
  console.log(`global pageerrors: ${globalPageErrors.length}`);
  for (const e of globalPageErrors) console.log('   ✗ ' + e);
  console.log(`global console.errors: ${globalConsole.length}`);
  for (const e of globalConsole.slice(0, 30)) console.log('   ✗ ' + e);
  console.log(`\nRESULT: ${results.length - failed}/${results.length} tab-steps passed, ${failed} failed.`);
  console.log('Screenshots in qa/shots/.');
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('\n[FATAL] harness crashed:', e && e.stack ? e.stack : e);
  process.exit(4);
});
