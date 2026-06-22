# Security Policy

## Reporting a vulnerability

Please **do not open a public GitHub issue** for security problems.

Email **Moshe Fridin** at **m0shiko8811@gmail.com** with:

- A description of the issue and its potential impact
- Steps to reproduce, or a proof-of-concept if available
- Any suggested fix or mitigation

You will receive an acknowledgement. I will work on a fix and coordinate responsible disclosure before any public discussion.

## Scope

| Component | Area |
|---|---|
| **Firmware** (ESP32 / BLE) | Pairing and bonding flow, RTCM relay, LittleFS flash storage |
| **App** (React Native) | BLE link and characteristic access, NTRIP credential handling, WebView (map), local storage |
| **SeisConv** (Electron) | Electron sandbox configuration (contextIsolation, CSP, preload bridge), file parsing of untrusted input |

## Security design notes

- BLE is encrypted with Secure Connections + bonding (static passkey pairing). All GATT characteristics require an encrypted link.
- NTRIP credentials are stored in the Android OS keystore via expo-secure-store — not in the codebase or repository.
- The SeisConv Electron window uses `contextIsolation: true`, `nodeIntegration: false`, a sandboxed preload bridge, and a `default-src 'none'` CSP. Window navigation is denied.
- No analytics, telemetry, or remote logging is present in any component.
