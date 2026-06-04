# SeisConv — desktop seismic toolkit

A branch of the **SmartSeismicSystem** platform. Cross-platform Electron desktop
app for reading, converting, inspecting, viewing, and QC-ing seismic data.
Brand-themed (deep navy + teal/cyan, glassmorphism). Full design history:
`~/.claude/plans/vast-herding-phoenix.md`.

## Features
- **Converter** — open SEG-Y (Rev 0/1/2) · SEG-D (Rev 1/3) · SEG-2 / Geode `.dat` · SU · tape image (`.tpimage`); convert to SEG-Y (Rev 0/1) or SU; **batch** convert many files → ZIP.
- **Trace Inspector** — per-trace wiggle on canvas, prev/next/slider navigation.
- **File Viewer** — full section: variable-density / wiggle / variable-area / VD+wiggle, colormap (seismic / gray / amber / viridis), gain, AGC.
- **SPS 2.1** — load S/R/X files, survey plot (sources/receivers), a **geographic (WGS84)** view, QC (duplicates / gaps / intervals / X-file existence / elevation / offset), and **reprojection export** to any EPSG target (UTM, ITM, BNG, RD, ED50…) → ZIP.
- **Velocity** — NMO semblance panel, click-to-pick, export picks CSV.

## Architecture
- **`core/`** — pure TypeScript engine, **no Electron/DOM** (runs in Node, a worker, or a browser; 25/25 unit tests):
  `binary` · `detect` · `formats/{segy,segd,seg2,su,tapeimage}` + `registry` ·
  `coords` (TM/UTM/ITM + Helmert 7-param) · `dsp/{agc,interpolate,semblance}` ·
  `render/{colormaps,model}` · `sps/{parse,qc,reproject}` · `base64`.
- **`workers/parse.worker.ts`** — long-lived, stateful: parses a file once and
  serves summary / trace / section / convert / SPS / semblance requests off the
  UI thread (transferable buffers). No big file ever blocks the window.
- **`electron/`** — `main` (window + native dialogs + worker driver) and a
  sandboxed `preload` bridge (`contextIsolation`, no `nodeIntegration`; window
  navigation denied; CSP `default-src 'none'`).
- **`renderer/`** — esbuild-bundled modular TS UI (`src/app.ts`), a 5-tab shell.

## Run
```bash
cd seisconv
npm install      # electron + toolchain
npm test         # core unit tests (25/25)
npm start        # build + launch the app
npm run typecheck
npm run dist     # package an installer (electron-builder)
```
Heavy installs/builds also run on the server (see `~/.claude/.../build-on-server`).
Test data: `D:\Projects\SeisconvApp\Data_Games` (seismic) and `…\SPS_Games` (SPS).

## Known follow-ups
- A live **tiled basemap** for SPS (Leaflet + OSM) on top of the current
  geographic view — deferred (adds a dependency + network + a CSP relaxation).
- TPIMAGE **writer** (creating tape images) — reader is done.
- A light/dark **theme switcher** and an in-app **help** panel.

## Branding
The user's own product — **no GII references**. SEG-Y writer tag is `SeisConv`
(`WRITER_TAG` in `core/formats/segy.ts`).
