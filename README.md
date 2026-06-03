<p align="center">
  <img src="docs/logo.png" alt="SmartSeismicSystem" width="340"/>
</p>

<h1 align="center">SmartSeismicSystem</h1>
<p align="center"><strong>Pinpoint the source. Own the future.</strong></p>
<p align="center">Centimeter-accurate RTK GPS + Up to nano second -precise seismic shot timing — on hardware and code built in-house.</p>

<p align="center">
  <img src="https://img.shields.io/badge/MCU-ESP32-000000?logo=espressif&logoColor=white" alt="ESP32"/>
  <img src="https://img.shields.io/badge/App-Expo_SDK_56-1B1F23?logo=expo&logoColor=white" alt="Expo SDK 56"/>
  <img src="https://img.shields.io/badge/RTK-cm--level-00E676" alt="RTK cm-level"/>
  <img src="https://img.shields.io/badge/BLE-encrypted-0A84FF?logo=bluetooth&logoColor=white" alt="BLE encrypted"/>
  <img src="https://img.shields.io/badge/release-v2.8.1-blue" alt="release v2.8.1"/>
</p>

---

## What it is

A field tool for **seismic surveys** — two parts that talk over Bluetooth:

> **RTK GPS gives the _where_. A hammer-strike trigger gives the _when_.**
> Together they geolocate every seismic shot to the **centimeter** and timestamp it to the **up to Nano second** — replacing bulky, expensive commercial gear with a phone + a matchbox-sized device.

- 🛰️ **`firmware/`** — ESP32 + u-blox RTK-GPS: centimeter positioning, a GPIO32 falling-edge ISR shot trigger with up to Nano second UBX-NAV-PVT timestamps, RTCM relay over **encrypted** BLE, LittleFS waypoint/shot storage.
- 📱 **`app/`** — Expo SDK 56 / React Native: BLE link, NTRIP correction relay, live Leaflet map, survey + averaging, the **Shots** tab, stakeout, QC, and CSV/photo export in ITM / EPSG.

## Features

| | |
|---|---|
| 🎯 **Centimeter RTK** | u-blox multi-band + NTRIP corrections relayed phone → device |
| ⏱️ **up to Nano second shots** | hammer/plate trigger → ISR → UBX-NAV-PVT timestamp |
| 📡 **Survey** | line/station numbering, 5-point averaging, retake |
| 🗺️ **Live map** | Leaflet / OSM, offline tile cache, waypoint + shot layers |
| 🧭 **Stakeout** | navigate to planned points |
| ✅ **QC** | duplicate / no-fix / accuracy / station-gap checks |
| 📤 **Export** | CSV (ITM / EPSG), KML, photos; raw NMEA log |
| 🔊 **Field UX** | voice prompts + shot / waypoint sounds |

## Architecture

```mermaid
flowchart LR
  ANT([GNSS antenna]) --> GPS[u-blox RTK GPS]
  GPS -->|"NMEA + UBX · UART 38400"| ESP[ESP32]
  ESP -->|"RTCM + config"| GPS
  HAMMER([Hammer + plate]) -->|"GPIO32 ISR"| ESP
  ESP <-->|"encrypted BLE"| PHONE[Android app]
  PHONE -->|"internet"| NTRIP[(NTRIP caster)]
  NTRIP -->|"RTCM"| PHONE
  ESP -->|"GPIO25-27"| LED[RGB status LED]
```

**Wiring (ESP32):**

| Pin | To | Notes |
|---|---|---|
| `GPIO16` / `GPIO17` | GPS TX / RX | UART1, 38400 8N1 |
| `GPIO25` / `26` / `27` | RGB LED R / G / B | status |
| `GPIO32` | hammer (plate → GND) | `INPUT_PULLUP`, falling-edge = shot |

### How to wire it

```mermaid
flowchart LR
  BATT([5V USB / power bank]) -->|"5V · GND"| ESP[ESP32]
  ANT([GNSS antenna]) --> GPS[u-blox GPS]
  GPS -->|"TX → GPIO16"| ESP
  ESP -->|"GPIO17 → RX · 3V3 · GND"| GPS
  ESP -->|"R/G/B → GPIO25/26/27"| RGB[RGB LED]
  RGB -->|"– → GND"| ESP
  HAMMER([Hammer]) -->|"→ GPIO32"| ESP
  PLATE([Steel plate]) -->|"→ GND"| ESP
  ESP <-->|"encrypted BLE"| PHONE[Android phone]
```

## Roadmap

- 🚜 **"Waze" for vibroseis fleets** — live fleet map + turn-by-turn to every source point, fully offline.
- 🤖 **Autonomous source vehicles** — driver-assist → self-positioning at the source point.
- 📟 **The trigger in your pocket** — phone + matchbox device replacing commercial trigger boxes.

## Build & flash

- **App** — `build.ps1` builds on the build server and installs to the phone (MIUI-safe). Or grab the prebuilt APK from Releases.
- **Firmware** — PlatformIO (`pio run -t upload`), or flash `firmware.bin` from a release with esptool. BLE is encrypted — pair with the device passkey on first connect.

## Releases

Prebuilt **Android APK** + ESP32 **firmware.bin** are attached to each tagged release → [**v2.8.1**](../../releases/tag/v2.8.1).

---

<p align="center"><sub>Built by <b>Moshe Fridin</b> with <b>Claude</b>.</sub></p>
