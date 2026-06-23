# SeisConv — working conventions (read before editing)

SeisConv is an Electron + TypeScript desktop seismic toolkit (converter, viewers, SPS geometry, observer's log). Private, proprietary/UNLICENSED. **No GII branding anywhere.**

## Architecture (where things live)
- `core/` — pure TS, no DOM/Electron. `formats/` (segy·segd·seg2·su·tapeimage parsers+writers), `sps/` (+`formats/` segp1·p111·p611·coordcsv, bingrid), `dsp/` (fft·agc·semblance·avgspectrum·spectrogram·fk·correlate), `coords`, `render`, `export`. Runs in Node, the worker, and the browser — keep it pure + unit-tested.
- `workers/parse.worker.ts` — long-lived stateful worker; parses once, serves summary/trace/section/convert/SPS/spectrum via transferable buffers.
- `electron/main.ts` + `electron/preload.ts` — BrowserWindow, native dialogs, IPC. Sandboxed renderer (contextIsolation, no nodeIntegration, CSP default-src 'none').
- `renderer/src/app.ts` (~7k lines, ONE file) + `renderer/index.html` — the 8-tab UI, esbuild-bundled.
- **Only ONE agent stream edits `app.ts`/`index.html` at a time** — concurrent edits corrupt the file. Sequence renderer work; parallelize only across different files (new `core/` modules, etc.).

## Build + verify gates (run from `seisconv/`)
```
npm run typecheck    # tsc --noEmit
npm run build        # esbuild: main/preload/worker/renderer
npm run test:core    # 58+ unit tests (4 skip without local fixtures)
npm run qa           # Playwright _electron drives every tab; 10/10 + 0 page/console errors
```
All four must be green before committing.

## VERIFY LIVE — do not claim a UI fix done off code-review alone
For any visual/behavioural change, **drive the built app and look at it** before saying it works:
- `npm run build`, then a Playwright `_electron` driver (mock `dialog.showOpenDialog`, click through the flow, `win.screenshot(...)`), then **Read the screenshot**. The `npm run qa` harness (`qa/drive.mjs`) is the baseline; write a throwaway `qa/_*.mjs` driver for new flows the harness doesn't cover, run it, read the shots, then delete it.
- Reproduce bugs on the user's REAL data (SPS at `D:\Projects\SeisconvApp\SPS_Games\...`, SEG-Y at `D:\Projects\SeisconvApp\Data_Games\...`), not synthetic stubs. "build green / tests pass" is necessary, not sufficient.

## Hard correctness/safety rules
- Bound every parser (MAX_TRACES / MAX_SAMPLES_PER_TRACE / line + length caps); never allocate from an attacker-controlled count. Malformed input → collect into errors/skipped, never throw.
- No NaN to a canvas (guard finite + min<max on every numeric that reaches a draw).
- Sandboxed renderer: use in-app modals/toasts, NOT window.prompt/confirm/alert. The worker can't use `new Date()`/`Math.random()`; the renderer can.
- SEG-Y/SEG-D samples carry **no physical unit** — label amplitude "Amplitude (sample value)", never invent "mV".
- Reject prototype-pollution keys (`__proto__`/`constructor`/`prototype`) on any dynamic-key path.

## Delivering the installer
Heavy build runs on the server, then the .exe goes to the user's **REAL desktop**: `C:\Users\moshef.GII\OneDrive - The Geophysical Institute Of Israel\Desktop\` — NOT `C:\Users\moshef.GII\Desktop\` (a hidden folder the user never sees). Flow + creds: see the `seisconv-installer-build` memory. **Never commit the server password.** Always `rm -rf dist` before electron-builder (the `files:["dist/**"]` glob otherwise re-bundles prior output). Correct lean size ≈ 80 MB.

## Gated (do NOT do without explicit OK)
Merge to master · publish/flip repo public · create the org · cut a release · commit the README/`docs/marketing/` drafts.
