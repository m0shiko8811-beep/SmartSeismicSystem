# SmartSeismicSystem -- Positioning & Messaging

> Internal reference. Use the sections below to populate the root README, product
> pages, release announcements, and any external showcase copy.
> Do not claim a capability that is not verified in code.

---

## Tagline

**Pinpoint the source. Own the future.**

---

## Umbrella positioning paragraph

SmartSeismicSystem is a personal seismic-acquisition platform built by Moshe
Fridin. It spans three complementary products in one monorepo -- a matchbox-sized
ESP32 trigger device, an Android field app, and a desktop data toolkit -- covering
the full workflow from stake-out and shot-timing in the field to format conversion
and QC in the office. Each product stands alone and ships independently; together
they form a single, owner-controlled stack for land seismic acquisition that
replaces several categories of commercial hardware and software.

---

## Per-product one-liners

| Product | One-liner |
|---|---|
| **firmware/** -- ESP32 trigger device | Centimeter RTK positioning and millisecond-precise seismic shot timing in a matchbox-sized ESP32 unit, source-agnostic across hammer, explosive, and vibroseis sources. |
| **app/** -- Survey GPS (Android) | Android field app that controls the trigger device over encrypted BLE, relays NTRIP RTK corrections, records waypoints and shots, and exports survey data in standard geodetic formats. |
| **seisconv/** -- SeisConv desktop toolkit | Cross-platform Electron desktop tool for reading, converting, inspecting, viewing, and QC-checking seismic data in SEG-Y, SEG-D, SEG-2, SU, and Tape Image formats. |

---

## Root README -- "What it is" block (ready to paste)

SmartSeismicSystem is a personal seismic-acquisition platform that covers the
full workflow from field stake-out and shot-timing to office format conversion
and QC -- in three complementary products that share one monorepo and one brand.

    firmware/   ESP32 trigger device
                Centimeter RTK positioning (u-blox NEO-M9N) + millisecond-precise
                shot timing via GPIO32 ISR + UBX-NAV-PVT. Source-agnostic: fires
                on any contact closure or trigger pulse (hammer/plate, explosive
                blaster, vibroseis time-break). Encrypted BLE to the phone.

    app/        Survey GPS -- Android field app (Expo SDK 56 / React Native)
                Controls the device over encrypted BLE, relays NTRIP RTCM3
                corrections phone -> device, records waypoints (5-point averaging,
                stakeout, QC) and shots (line/SP/step numbering, CSV import/export),
                and renders a live Leaflet / OpenStreetMap survey map.

    seisconv/   SeisConv -- desktop seismic data toolkit (Electron + TypeScript)
                Reads, converts, inspects, and QC-checks SEG-Y (Rev 0/1/2),
                SEG-D (Rev 1/3), SEG-2 / Geode .dat, Seismic Unix, and Tape Image
                files. Single-file or whole-folder batch conversion. Worker-thread architecture:
                large files never block the UI.

RTK GPS gives the where.
The source trigger gives the when.
SeisConv handles what comes back from the field.

---

## Release notes -- SeisConv 0.1 initial release

SeisConv is a desktop seismic data toolkit built on Electron with a
pure-TypeScript processing core. This first release delivers a complete
read-convert-inspect-QC workflow across six seismic formats, with a
worker-thread architecture that keeps the UI responsive on large files.

### Format support

| Format | Read | Write | Notes |
|---|---|---|---|
| SEG-Y Rev 0 / 1 / 2 | Yes | Yes | Writer tag: SeisConv; round-trip sample-exact |
| SEG-D Rev 1 / 3 | Yes | Yes* | Writer round-trips through the bundled parser; not validated against vendor acquisition software (Sercel/SEAL, ION, Geospace) |
| SEG-2 / Geode .dat | Yes | Yes | |
| Seismic Unix (SU) | Yes | Yes | |
| Tape Image (.tpimage) | Yes | Yes | Wraps a SEG-Y internally; parseTpimage recovers the embedded file |
| CSV | -- | Yes | ASCII amplitude export |

Two conversion modes: a single file (with a save dialog), or a whole folder -- a
wizard asks for the output format + destination, then every seismic file converts
with a live per-file progress bar and a cancel button. The parser runs on a worker thread.

### GUI features

- **Converter tab** -- two modes: single file, or folder batch with a
  format/destination wizard, live progress, and cancel; plus clear-state, an
  in-app manual, and a light/dark toggle.
- **Trace Inspector** -- per-trace wiggle, prev/next/slider navigation,
  FFT amplitude spectrum panel.
- **File Viewer** -- full section display in four modes (variable-density, wiggle,
  variable-area, VD+wiggle) with four colormaps (seismic, gray, amber, viridis),
  manual gain, and AGC.
- **SPS 2.1 tab** -- load S/R/X files, geographic (WGS84) survey map via Leaflet,
  QC checks (duplicates, gaps, station intervals, X-file consistency, elevation,
  offset), and reprojection export to any EPSG target (UTM, ITM, BNG, RD, ED50,
  and hundreds more) as a ZIP.
- **Velocity tab** -- NMO semblance panel, click-to-pick velocity function,
  export picks as CSV.

### Architecture

- **core/** -- pure TypeScript, no Electron or DOM dependency. Runs in Node, a
  worker, or a browser. Covered by 50 unit tests (coordinate round-trips, format
  parsers/writers, DSP, SPS QC, FFT, robustness on truncated and adversarial
  buffers, SEG standard compliance regressions).
- **workers/parse.worker.ts** -- long-lived stateful worker: parses a file once,
  serves summary / trace / section / convert / SPS / semblance requests off the
  UI thread using transferable buffers.
- **electron/** -- sandboxed renderer (contextIsolation, no nodeIntegration,
  CSP default-src none), NSIS installer for Windows.

### Security hardening in the parsers

Two parser allocation findings were fixed before this release:

- **SEG-2**: a crafted file could declare a huge nSamples value decoupled from
  the on-disk data-block size, causing the worker to attempt a multi-gigabyte
  allocation. The parser now bounds nSamples by the actual data-block byte
  budget, then applies a file-wide total allocation cap across all traces.
- **SEG-D**: the 20-bit packed-format branch did not clamp sptStored to
  remaining bytes; fixed.

Both fixes are guarded by regression tests that craft hostile buffers and assert
parsed sample counts stay within O(file size).

### Installer status

- **Windows** -- NSIS installer via electron-builder. No code-signing certificate;
  Windows SmartScreen will warn on first run. Dismiss with "More info, Run anyway."
- macOS DMG and Linux AppImage targets are defined in electron-builder config but
  not built or distributed in this release.

### Known gaps and roadmap

- SEG-D write is not yet validated for interchange with Sercel, ION, or Geospace
  acquisition software.
- Tiled basemap (Leaflet, Dark / Satellite / Streets) and theme toggle are
  implemented; multi-tile offline caching is not yet present.
- SEG-D Rev 2 support is not yet implemented.

---

## Honest capability quick-reference

Use these exact phrases. Do not embellish.

| Claim | Correct phrasing |
|---|---|
| GPS timing precision | Millisecond-precise today; nanosecond-capable once a PPS input is added. |
| RTK accuracy | Centimeter-level (1-2 cm) at RTK Fixed quality. |
| BLE security | Encrypted BLE (Secure Connections + bonding, static passkey). |
| SEG-D write | Writes SEG-D Rev 1 and Rev 3; not yet validated against vendor acquisition software. |
| Test coverage | 50 unit tests covering parsers, writers, coordinates, DSP, SPS QC, FFT, and SEG-standards regressions. |
| Installer signing | Windows installer is unsigned; SmartScreen will warn on first run. |

---

## What to avoid

- "Nanosecond-precise" or "nanosecond timing" as a present fact -- the PPS path is
  not yet wired.
- Any claim that SEG-D output is compatible with Sercel/ION/Geospace recorders.
- Any employer or third-party branding.
- Invented benchmarks, customer names, or deployment counts.

---

*Built by Moshe Fridin with Claude. Personal project -- not affiliated with any employer or third party.*
