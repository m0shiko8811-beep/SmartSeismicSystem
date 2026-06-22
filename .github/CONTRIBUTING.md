# Contributing to SmartSeismicSystem

This is a personal project — contributions are welcome but the scope is intentional. Read this before opening a PR.

## What lives where

| Directory | Stack | Notes |
|---|---|---|
| `firmware/` | C++ / Arduino / PlatformIO | ESP32, board `nodemcu-32s` |
| `app/` | Expo SDK 56 / React Native / TypeScript | Android only |
| `seisconv/` | Electron 33 + TypeScript | Windows / macOS / Linux |

## Getting set up

**Firmware**
```bash
cd firmware
# open in PlatformIO (VS Code extension or CLI)
pio run -t upload
```

**App**
```bash
cd app
npm install
# build with app/build.ps1 (requires the Linux build server)
# or: npx expo start --android for development
```

**SeisConv**
```bash
cd seisconv
npm install
npm test        # core unit tests (50; file-backed ones skip without sample data)
npm start       # build and launch
```

## Before opening a PR

- Keep changes focused. Describe the **what** and **why** in the PR description — not just what changed.
- Match the surrounding code style; do not introduce new linters or formatters without discussion.
- **No secrets, keys, passkeys, or credentials** in code, comments, or git history.
- **Firmware:** keep ISR handlers minimal; never block `loop()` or call `Serial.print` from an ISR.
- **App:** use Expo SDK 56 APIs only — check [docs.expo.dev/versions/v56.0.0/](https://docs.expo.dev/versions/v56.0.0/) before writing any Expo call.
- **SeisConv core:** the `core/` package must remain free of Electron and DOM imports.
- Test on real hardware where you can — firmware changes on the ESP32 device, app changes on a physical Android phone.
- Update the relevant README and CHANGELOG if your change affects user-facing behavior.

## Reporting bugs and ideas

Use the issue templates:
- **Bug report** — something that is broken or incorrect
- **Feature request** — an idea or proposal

For security issues, see [SECURITY.md](SECURITY.md) — do not open a public issue.
