---
description: Build-gate, live-verify, commit, and ship the SeisConv installer to the user's OneDrive Desktop
---

Ship the current SeisConv work end-to-end. Follow the measure-twice rule — do not skip the live verify.

1. **Gates** (from `seisconv/`): `npm run typecheck && npm run build && npm run test:core && npm run qa`. All green, or stop and fix.
2. **Verify live** for any UI/behaviour change: drive the built app on the user's REAL data (use the `seisconv-verify` agent or `node qa/verify.mjs <tab>` + read the screenshot). Confirm what you see matches what was built. Reproduce the original report if this was a bug fix.
3. **Commit** the code (exclude the gated README / `docs/marketing/`): a clear conventional-commit message ending with the required Co-Authored-By + Claude-Session footer, then `git push`.
4. **Installer**: use the `seisconv-release` agent (or the documented server flow) to build on the server and deliver `SeisConv-Setup-0.1.0.exe` to `C:\Users\moshef.GII\OneDrive - The Geophysical Institute Of Israel\Desktop\`. Confirm it lands (~80 MB).
5. **Report** what shipped, the live-verification evidence (screenshots), and the installer path/size. Ping the user if they're away.

Arguments after the command name describe what to ship; if empty, ship whatever is committed/uncommitted on the current branch per the above.
