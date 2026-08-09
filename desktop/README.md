# TCB Phone — Desktop App

A thin Electron wrapper around the TCB VoIP staff admin dashboard
(https://tcb-voip.phill-abb.workers.dev/). It's just a window pointed at the
live site — no offline mode, no local data, no auto-updates. All feature and
content changes ship through the worker itself and need no app update; only a
shell-level change (e.g. bumping the Electron version) would ever require
staff to re-download.

## Building the installer

```bash
cd desktop
npm install
npm run build
```

This produces `desktop/release/TCB-Phone-Setup-<version>.exe`.

## Distributing to staff

1. Build the installer locally (above).
2. Upload the `.exe` to a new [GitHub Release](https://github.com/phill-svg/phone-system/releases) on this repo.
3. Share the release download link with staff.

There is no auto-update. Re-distribute a new installer (and ask staff to
re-run it) only when the desktop shell itself changes — not for normal
dashboard updates, which are live immediately for everyone.

## Heads-up for whoever shares the download link

The installer is **not code-signed** (no code-signing certificate — that's a
paid service and not worth it for an internal tool with a handful of users).
Windows SmartScreen will show a blue "Windows protected your PC" warning the
first time someone runs it. This is expected, not a sign of a broken or
malicious file. Tell staff in advance:

> Click **"More info"**, then **"Run anyway"**. This screen shows up because
> the app isn't from a large publisher registered with Microsoft, not because
> anything is wrong with it.

## Local dev run

```bash
cd desktop
npm install
npm start
```
