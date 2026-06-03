# Contributing to SmartSeismicSystem

Thanks for your interest! This is a two-part project:

- **`firmware/`** — ESP32 / PlatformIO (Arduino C++)
- **`app/`** — Expo SDK 56 / React Native (TypeScript)

## Getting set up
- **Firmware:** open `firmware/` in PlatformIO; board `nodemcu-32s`; `pio run -t upload`.
- **App:** `cd app && npm install`, then build/run via Expo. (See the README for the build pipeline.)

## Before a PR
- Keep changes focused; describe the *what* and *why*.
- Match the surrounding style; **no secrets, keys, or credentials** in code or history.
- **Firmware:** keep ISR work minimal and never block `loop()`.
- **App:** use the Expo SDK 56 APIs (verify against the v56 docs).
- Test on real hardware where you can — firmware on the ESP32, app on Android.

## Reporting bugs / ideas
Open an issue using the templates. For anything security-related, see [SECURITY.md](SECURITY.md).
