# Changelog

All notable changes to the GPS Survey Tool are documented here.

---

## [2.8.1] — 2026-06-02 (build 281)

### Security hardening (app + firmware)

- **SSH build password no longer hardcoded**
  - **Root cause**: `build.ps1` carried the build server's SSH password in plaintext (committed to the repo).
  - **Fix**: `build.ps1` now reads it from `$env:SGPS_PW` (or a hidden prompt); the server password was rotated. (The old value remains in git history — scrub if the repo is ever shared.)
- **NTRIP credentials moved to the OS keystore**
  - **Root cause**: saved NTRIP presets (including passwords) were stored in plaintext `AsyncStorage`.
  - **Fix**: `storage.ts` now stores them via `expo-secure-store`, with a one-time migration that deletes the old plaintext copy.
- **BLE link encrypted (firmware)**
  - **Root cause**: the BLE GATT command/RTCM interface was open — any device in range could send `wp_clear`/`shot_clear`/`shot_cfg` or inject RTCM.
  - **Fix**: added `BLESecurity` (Secure Connections + bonding, static passkey **471129**) and marked the GPS/CMD/RTCM characteristics `ESP_GATT_PERM_*_ENCRYPTED`. The phone must re-pair once after flashing.
- **Map WebView hardened**: `originWhitelist` restricted to `https://localhost`, external navigation blocked, multiple windows disabled (labels were already HTML-escaped via `escHtml`).

### Build pipeline

- **`build.ps1` MIUI-safe install**: starts the adb server first so its harmless "daemon not running" stderr no longer aborts the run under `-ErrorActionPreference Stop`, and falls back to `adb push` + `pm install -r` because MIUI blocks streamed `adb install` (`INSTALL_FAILED_USER_RESTRICTED`).

---

## [2.8.0] — 2026-06-01 (build 280)

### Seismic shot trigger (firmware + app)

- **New**: a hammer/plate contact on **GPIO32** fires a FALLING-edge ISR that records a **shot** with a millisecond-precise GPS timestamp + position; shots persist to LittleFS and sync over BLE (`shot_cfg` / `shot_list` / `shot_clear` / `shot_delete` + live shot events).
- **App**: new **Shots** tab (line/SP/step/edge/debounce config, good/bad marking, CSV export) and CSV **shot-plan import**.
- **Timestamp precision (fix)**
  - **Root cause**: `buildTimestampAt` only carried the ms offset into seconds (clamped at 0/59), so timestamps were up to a minute wrong at minute boundaries, and a stale NAV-PVT produced garbage.
  - **Fix**: proper epoch math (carries seconds → minutes → hours → days) plus a 1.5 s NAV-PVT freshness guard.
- **Flash wear (fix)**: each shot now **appends** a single line instead of rewriting the whole file.

### Field services (app)

- **Voice prompts** via `expo-speech` (the previous `AccessibilityInfo.announceForAccessibility` only spoke when TalkBack was enabled — silent for normal users).
- **Shot/waypoint sounds** via `expo-audio` (replaced a hidden audio WebView suspected of stealing touch input from the Leaflet map).
- **NMEA logging** that actually appends (the old `{ append: true }` option was a no-op that overwrote the file each write).
- **Stakeout navigation**, **QC checks** (duplicate / no-fix / poor-accuracy / station-gap), and **photo + EPSG/ITM CSV export**.
- **Shot id sync (fix)**: deleting a shot now mirrors the firmware's 1..n renumber so app/device ids stay aligned.

---

## [2.7.0] — 2026-05-27 (build 270)

### Map — fix WP/distance label background clipping

- **Root cause**: `.wp-label` and `.dist-label` were `display:block` inside the Leaflet divIcon container (`width:0;height:0`). Android WebView does not compute intrinsic width for block elements inside zero-size parents, so the background painted at 0 px wide while the text still overflowed visibly.
- **Fix**: Added `display:inline-block` to both CSS classes — forces the element to size itself to its content regardless of the parent container dimensions.

---

## [2.6.0] — 2026-05-27 (build 260)

### Map — per-line polylines

- **Root cause**: `updateWaypoints` drew one continuous polyline through all waypoints in save order. Two opposite-direction passes connected end-to-end, laterally offset by GPS accuracy, produced a tangled zig-zag.
- **Fix**: Waypoints are now grouped by the label prefix before the colon (`"1001"` from `"1001:5"`). Each group gets its own colored polyline (green → orange → blue → pink → …), sorted by station number ascending. Distance labels are drawn only within each group.
- Labels without a colon are treated as individual markers (no line drawn).
- `var wpLine` (single) replaced by `var wpLines` (array of per-group polylines).

---

## [2.5.0] — 2026-05-27 (build 250)

### Fix quality (fixQ) debounce — firmware + app

- **Root cause**: u-blox NEO-M9N momentarily outputs GGA quality=0 between RTCM correction epochs (~every 1 s). Without debouncing, fixQ oscillated 0↔2 every second, burying RTK Fixed/Float transitions in noise.
- **Firmware**: `sendDbg("fixQ=X")` now only fires after the new quality value has been continuously observed for ≥ 2 s. Two new statics — `fixQCandidate` / `fixQCandidateMs` — track the candidate value and when it was first seen.
- **App**: `GpsContext` maintains a `stableFixQRef` (debounced fixQ shown in UI and logged to activity log).
  - Upward changes (e.g., 0→2, 2→4, 4→5) are applied **immediately** — RTK improvement is always real.
  - Downward changes start a 2-second timer; if the value recovers before the timer fires, the drop is silently discarded.
  - `rawFixQRef` is updated on every GPS message so the timer always settles on the *latest* observed value, not a stale closure.
  - Debounce state is fully reset on BLE disconnect and on GPS fix loss.

---

## [2.4.0] — 2026-05-27 (build 240)

### NTRIP — critical fixes
- **TCP no-delay**: added `noDelay: true` to the socket options — disables Android's Nagle algorithm which was buffering the HTTP GET request and never flushing it. The server received no request, kept the connection open, and the 15s timer fired. This was the primary timeout cause.
- **Write confirmation**: switched to `socket.write(data, 'utf8', callback)` — if the write fails the error is reported immediately instead of waiting for timeout.
- **SOURCETABLE detection**: `SOURCETABLE 200 OK` is returned when the mountpoint is offline. Previously `header.includes('200 OK')` matched this and treated it as a successful connection (would dump source-table text as RTCM to ESP32). Now only `ICY 200 OK` or `HTTP/x.x 200` (NTRIP 2.0) are accepted; SOURCETABLE triggers a clear error: "Mountpoint not found or base station offline".
- **Early close detection**: if the server closes the TCP connection before the NTRIP handshake completes, the error is reported immediately instead of waiting for the 15s timeout.

---

## [2.3.0] — 2026-05-27 (build 230)

### Bug fixes
- **NTRIP header parser**: NTRIP 1.0 casters (including rtk2go.com) send `ICY 200 OK\r\n` followed immediately by binary RTCM data — no blank line. The parser was waiting for `\r\n\r\n` (HTTP double-CRLF) which never arrived, so the connection timed out every time even though TCP was working. Parser now handles both formats.
- **NTRIP write timing**: added 80 ms delay before writing the HTTP GET request inside the TCP connect callback — prevents a rare Android race where the write is buffered and never flushed.
- **Map WP/distance labels**: `L.divIcon` without `iconSize:[0,0]` defaults to Leaflet's 12×12 px clip box, cutting off the background behind labels. Fixed with `iconSize:[0,0]` on both `wpIcon` and `distIcon`.
- **Version footer**: removed the legacy branding suffix.

### Diagnostics
- New activity log events: `ntrip_request_sent` (fires when HTTP GET is written to socket) and `ntrip_server_data` (fires on first server byte, shows first 40 chars). These make it possible to distinguish "server not responding" from "parser failure".

---

## [2.2.0] — 2026-05-27 (build 220)

### Bug fixes
- **NTRIP**: added `Host:` header and upgraded request to HTTP/1.1 — rtk2go.com (and most NTRIP casters) silently reject HTTP/1.0 requests without a `Host:` header; TCP connected but server never sent ICY 200 OK.
- **Duplicate waypoint saves**: rapid double-tap on SAVE WAYPOINT sent two BLE save commands before the React `saving` state re-rendered. Added a synchronous `useRef` guard (`savingRef`) so the second tap is dropped immediately.

---

## [2.1.0] — 2026-05-27 (build 210)

### Bug fixes
- **WP list on map**: fixed race condition where firmware flushed the wp list before the app's BLE subscription was ready — all initial waypoints were silently dropped on every connect. App now explicitly re-requests `wp_list` 1 s after subscription is established.
- **Averaging multiple points**: same root cause as above — one AVG now correctly adds exactly one new point to the map.
- **BLE reconnect storm**: added `connectingRef` guard and `clearTimeout` before each reconnect schedule — prevents cascading parallel connection attempts that locked backoff at 60 s within 2 seconds.

### NTRIP
- Added 15-second connection timeout — server non-response now fires a clear `ntrip_error` instead of hanging silently forever.
- Added `onTcpConnected` callback and `ntrip_tcp_connected` log event — distinguishes TCP-reached-server vs. network-blocked.

### Engineering / Activity Log
- New **Activity Log** tab in the Log screen — real-time JSONL event feed from app + ESP32.
- Auto-refreshes every 2 seconds; color-coded by event category.
- Export button; exported filename now includes date + time: `activity_log_YYYYMMDD_HHMMSS.jsonl`.
- Clear button.

### ESP32 firmware (v7.1 — instrumentation)
- `sendDbg()` over BLE + Serial at 15+ instrumentation points: BLE connect/disconnect, GPS fix acquired/lost, fix quality change, each AVG sample (1/5…5/5), AVG done/timeout/cancel, every WP save, flash save/load, `cfg` applied, acc filter change, RTCM KB milestones.

### Other
- Version shown in Settings screen footer.
- `versionCode` added to `app.json` (210 = v2.1.0).

---

## [2.0.0] — 2026-05-26

### Firmware (ESP32 — main.cpp v7)

#### 1ms Timestamp Precision via UBX-NAV-PVT
- Enabled UBX-NAV-PVT binary output from NEO-M9N over the existing GPS UART (no hardware wiring required)
- Implemented a full UBX binary state machine (`processUBX()`) with Fletcher-8 checksum verification
- Extracted the `nano` field (nanoseconds offset, –5 ms to +995 ms) from NAV-PVT payload
- `buildTimestamp()` now produces `"YYYY-MM-DDTHH:MM:SS.mmm"` at true 1 ms precision
- Fallback to NMEA centiseconds (`"YYYY-MM-DDTHH:MM:SS.cc0"`) when UBX fix is not yet available
- Sends CFG-VALSET and CFG-MSG to the GPS chip at startup to activate NAV-PVT output

#### Memory Optimisation — WP Struct Reduced by ~240 Bytes
- Removed `gga[82]`, `gsa[82]`, and `rmc[82]` NMEA string fields from the `WP` struct
- Each waypoint drops from ~326 bytes to ~80 bytes — saves ~49 KB at WP_MAX=200
- Flash storage format updated: `label|lat|lon|alt|hdop|fixQ|ts` (7 fields, no NMEA)
- `loadWaypointsFromFlash()` uses `strtok` with field-count guard — backward compatible with old 10-field format

#### Retake Last N Waypoints
- New BLE command: `{"cmd":"wp_delete_last","n":<count>}`
- Removes the last `n` waypoints from the LittleFS store and updates `lastWPLat/Lon`
- Responds with an updated `gps` JSON notification so the phone reflects the new waypoint count

#### Station Counter Removed from Firmware
- `wp_clear` handler no longer resets `stationNum` to 1 or writes to Preferences
- The phone exclusively owns the station counter — no risk of counter desync after clear/sync

#### NMEA Buffer Isolation
- Added `bool inNmea` flag in `loop()` — NMEA characters are only accumulated between `$` and `\n`
- Prevents UBX binary bytes from corrupting the TinyGPSPlus parser buffer

---

### Phone App (React Native / Expo SDK 56)

#### Waypoints: In-Memory Only
- Removed all AsyncStorage waypoint persistence (`loadWaypoints`, `saveWaypoints`, `appendWaypoint`, `clearWaypoints`)
- Waypoints now live only in React state; populated from BLE sync (`wp_list` → `wp` messages)
- Reduces storage.ts surface area; eliminates stale-data bugs on reinstall or device swap
- `syncFromDevice()` clears local state first, then re-requests the full list from the ESP32

#### Retake Last N Points (UI)
- New "Retake last _N_ point(s)" row at the bottom of SurveyScreen
- Numeric input (default 1) + red RETAKE button with confirmation Alert before destructive action
- On confirm: calls `deleteLastWaypoints(n)`, reverses the station counter by `n × step`, clears last-saved label
- Heavy haptic feedback on retake

#### Accuracy Filter Toggle
- Added enable/disable Switch to SettingsScreen — filter can be turned off without losing min/max values
- When disabled: SurveyScreen shows "⊘ Filter off" in the accuracy badge and allows saving regardless of HDOP
- Toggle state persists to AsyncStorage alongside min/max via updated `setAccSettings(min, max, enabled)`
- Both SurveyScreen and SettingsScreen read `accFilterEnabled` from GpsContext (single source of truth)

#### Real-World Accuracy Formula (NEO-M9N Datasheet Values)
- `hdopToAccuracy()` now uses per-fix-quality multipliers from the u-blox NEO-M9N datasheet:
  - Fix quality 4 (RTK Fixed): HDOP × 0.02 m (~2 cm)
  - Fix quality 5 (RTK Float): HDOP × 0.40 m (~40 cm)
  - Fix quality 2 (DGPS / SBAS): HDOP × 0.60 m
  - Fix quality 1 (Standard GPS): HDOP × 1.50 m
  - No fix: HDOP × 5.00 m

#### Map: Hide Marker on No-Fix
- Added `window.clearGps()` to the embedded Leaflet map — removes position dot and accuracy circle
- Called automatically when `gps.fix === false` or coordinates are non-finite
- Prevents stale position from showing after GPS signal is lost

#### Phone-Owned Station Counter
- Removed the `useEffect` that synced `line / station / step / countUp` from `gps?.cfg`
- Phone state is authoritative; `avgDone` handler calls `advanceStation()` locally instead of reading `next_sta` / `next_line` from the device
- No counter reset occurs on firmware clear or device reconnect

#### Silent Activity Log (System Engineers Only)
- New service: `src/services/activityLog.ts`
- Appends a JSONL entry on: `app_start`, `ble_connected`, `ble_disconnected`, `wp_saved`, `avg_started`, `avg_cancelled`, `wp_retake`, `wp_cleared`, `ntrip_sent`
- File location: `documentDirectory/activity_log.jsonl` (not exposed in any UI screen)
- Access via ADB: `adb exec-out run-as com.smartseismic.surveygps cat files/activity_log.jsonl`
- Provides a timestamped audit trail for post-survey review without affecting the field user experience

#### App Version
- Bumped from `1.0.0` to `2.0.0` in `app.json`

---

## [1.0.0] — Initial Release

- BLE connection to ESP32 GPS-Survey device
- Real-time GPS status: fix quality, HDOP, satellite count, NTRIP state
- Survey screen: line/station numbering, save waypoint, 5-point averaging
- Map screen: live position dot + waypoint markers (Leaflet / OpenStreetMap)
- Log screen: scrollable waypoint list with export
- Settings: NTRIP config with save/load presets, antenna height, accuracy filter
- NTRIP relay: phone handles TCP connection, forwards RTCM3 to device over BLE RTCM_CHAR
