// SeisConv QA harness — reusable Playwright _electron helpers.
// Import from drive.mjs, verify.mjs, or any throwaway qa/_check.mjs so the
// launch / mock-dialog / open-file / tab / screenshot boilerplate is written once.
import { _electron as electron } from 'playwright';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const APP_DIR = resolve(__dirname, '..');           // seisconv/ (package.json main=dist/main.js)
export const SHOTS = join(__dirname, 'shots');
mkdirSync(SHOTS, { recursive: true });

// Default real-data files (override via env).
export const SEGY = process.env.SEISCONV_QA_SEGY || 'D:\\Projects\\SeisconvApp\\Data_Games\\00000186_SegY_Rev2.segy';
export const SPS = (process.env.SEISCONV_QA_SPS || [
  'D:\\Projects\\SeisconvApp\\SPS_Games\\Yagur\\GP-0395-26.s01',
  'D:\\Projects\\SeisconvApp\\SPS_Games\\Yagur\\GP-0395-26.r01',
  'D:\\Projects\\SeisconvApp\\SPS_Games\\Yagur\\GP-0395-26.x01',
].join(';')).split(';').map((s) => s.trim()).filter(Boolean);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Launch the BUILT app; returns { app, win, errors } where errors collects
 *  pageerrors + console.error for the whole session. */
export async function launch() {
  const app = await electron.launch({ args: ['.'], cwd: APP_DIR });
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push('pageerror: ' + (e.message || e)));
  win.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  await win.waitForLoadState('domcontentloaded');
  await sleep(500);
  return { app, win, errors };
}

/** Point the MAIN-process open dialog at `paths`; save dialog cancels (write
 *  flows complete without touching disk). */
export async function mockDialogs(app, paths) {
  await app.evaluate(async ({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: p });
    dialog.showSaveDialog = async () => ({ canceled: true });
  }, paths);
}

/** Click a rail tab and wait for its panel to be visible. */
export async function gotoTab(win, tabId, panelId) {
  await win.click('#' + tabId);
  await win.waitForFunction((pid) => {
    const el = document.getElementById(pid);
    return el && getComputedStyle(el).display !== 'none';
  }, panelId, { timeout: 8000 }).catch(() => {});
  await sleep(250);
}

/** Open a seismic file via the Converter (header #openBtn or in-panel #openBtn2),
 *  waiting until the summary reflects THIS file. Returns the trace-count text. */
export async function openFile(app, win, path) {
  await mockDialogs(app, [path]);
  await win.click('#tab-conv'); await sleep(150);
  const onConv = await win.evaluate(() => { const p = document.getElementById('panel-conv'); return p && getComputedStyle(p).display !== 'none'; });
  await win.click(onConv ? '#openBtn2' : '#openBtn');
  const base = path.replace(/\\/g, '/').split('/').pop();
  await win.waitForFunction((b) => {
    const t = document.getElementById('fsTraces');
    const name = (document.getElementById('singleFoundName')?.textContent || document.getElementById('fiName')?.textContent || '').trim();
    return t && t.textContent.trim() && t.textContent.trim() !== '—' && name.includes(b);
  }, base, { timeout: 30000 }).catch(() => {});
  return (await win.textContent('#fsTraces'))?.trim();
}

/** Load an SPS triplet on the SPS tab (multiSelections). */
export async function loadSps(app, win, paths = SPS) {
  await gotoTab(win, 'tab-sps', 'panel-sps');
  await mockDialogs(app, paths);
  await win.click('#spsLoadBtn');
  await win.waitForFunction(() => { const s = document.getElementById('spsStats'); return s && s.textContent.trim().length > 0; }, null, { timeout: 20000 }).catch(() => {});
  await sleep(400);
}

/** Screenshot to qa/shots/<name>.png. */
export async function shot(win, name) {
  const p = join(SHOTS, name.endsWith('.png') ? name : name + '.png');
  await win.screenshot({ path: p }).catch(() => {});
  return p;
}
