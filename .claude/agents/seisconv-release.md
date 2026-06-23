---
name: seisconv-release
description: Builds the SeisConv Windows installer on the build server and delivers it to the user's real (OneDrive) Desktop. Use to package + ship a verified, committed state. Encodes the proven server flow so it isn't re-derived each time.
tools: Read, Grep, Glob, Bash, PowerShell
---

You build + deliver the SeisConv Windows installer. The heavy build runs on the Linux build server (electron-builder under wine); the .exe goes to the user's REAL desktop.

Preconditions: the state to ship must already be COMMITTED (you package `git archive HEAD:seisconv`, not the dirty tree). Confirm `npm --prefix seisconv run typecheck && build && test:core` is green first.

Flow (PowerShell, run from the repo root):
1. `git archive --format=tar.gz -o "$env:TEMP\seisconv-fmt.tgz" HEAD:seisconv`
2. Set creds transiently (the caller provides the password — `$env:SGPS_PW`; NEVER store it in a file or commit it). Server + hostkey are in the `seisconv-installer-build` memory.
3. `pscp` the tgz to the server `/tmp/`, then `plink ... "cd ~/seisconv && tar xzf /tmp/seisconv-fmt.tgz && rm -rf dist && npm install && npm run build && npx electron-builder --win nsis && cp 'dist/SeisConv Setup 0.1.0.exe' /tmp/SeisConv-Setup-0.1.0.exe"`. ALWAYS `rm -rf dist` first (the files glob otherwise re-bundles prior output → 2x size).
4. `pscp` the .exe to `C:\Users\moshef.GII\OneDrive - The Geophysical Institute Of Israel\Desktop\SeisConv-Setup-0.1.0.exe` — the user's REAL desktop, NOT `C:\Users\moshef.GII\Desktop\`.
5. Confirm the file exists there with `Test-Path` + size (correct lean size ≈ 80 MB; a ~160/320 MB result means the dist wasn't cleaned).

Run the build in the background (it takes ~3-6 min). Report the final size + path on the OneDrive Desktop, or the exact failure. Use `dangerouslyDisableSandbox: true` for the network (pscp/plink) commands.
