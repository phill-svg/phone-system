# TCB Phone — Desktop App

A thin Electron wrapper around the TCB VoIP staff admin dashboard
(https://tcbvoip.app/). It's just a window pointed at the
live site — no offline mode, no local data, no auto-updates. All feature and
content changes ship through the worker itself and need no app update; only a
shell-level change (e.g. bumping the Electron version) would ever require
staff to re-download.

## Desktop shortcut

The installer creates a Start menu entry but **not** a desktop icon. The app asks on its first
visible launch ("Add a TCB Phone shortcut to your desktop?") and remembers the answer in
`shell-prefs.json` under the app's userData folder, so a "no" is never asked again. It stays quiet
when the app auto-starts hidden at login, and skips the question entirely if a shortcut is already
there from an older installer.

Because the app writes that shortcut rather than the installer, uninstalling won't remove it — the
`.lnk` has to be deleted by hand.

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
