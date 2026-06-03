# Security Policy

## Reporting a vulnerability
Please **do not** open a public issue for security problems.

Instead, email **Moshe Fridin — m0shiko8811@gmail.com** with:
- a description of the issue and its impact,
- steps to reproduce (a proof of concept if possible),
- any suggested fix.

You'll get an acknowledgement, and I'll work on a fix and coordinate disclosure.

## Scope
- **Firmware** (ESP32 / BLE): pairing & bonding, the RTCM relay, flash storage.
- **App** (React Native): the BLE link, NTRIP credential handling, the map WebView, local storage.

BLE is encrypted and bonded (passkey pairing); NTRIP and other credentials are kept in the OS secure store, not in the code or repo.
