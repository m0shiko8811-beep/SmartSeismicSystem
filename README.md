# SmartSeismicSystem

Personal project by Moshe Fridin, built with Claude.

A two-part RTK-GPS seismic survey and shot-trigger system:

- `firmware/` — ESP32 + u-blox RTK-GPS (PlatformIO): cm-accurate RTK, ms-precise seismic shot trigger (GPIO32 ISR), encrypted BLE RTCM relay, waypoint/shot storage.
- `app/` — Expo SDK 56 / React Native: BLE link, NTRIP relay, Leaflet map, survey + shots, stakeout, QC, NMEA logging, CSV/photo export (ITM/EPSG).

Private repository.
