# TCB Phone — Desktop App

A thin Electron wrapper around the TCB VoIP staff admin dashboard
(https://tcbvoip.app/). It's just a window pointed at the
live site — no offline mode, no local data. All feature and content changes
ship through the worker itself and need no app update; only a shell-level
change (e.g. bumping the Electron version) needs a new installer, and the app
picks that up by itself (see below).

## Building the installer

```bash
cd desktop
npm install
npm run build
```

This produces `desktop/release/TCB-Phone-Setup-<version>.exe`.

## Shipping an update to staff

The app auto-updates. `electron-updater` polls `https://tcbvoip.app/desktop/latest.yml`
on launch and every six hours, downloads in the background, and offers a restart
from the tray menu and a notification. Nobody has to re-run an installer.

```bash
cd desktop
# bump "version" in package.json first — the updater compares against it
npm run build
npm run release:upload
```

`release:upload` puts the installer, its blockmap and `latest.yml` into the R2
bucket the worker serves `/desktop/` from. The manifest goes **last**, because it
is the switch that makes the version visible: publish it before the installer and
every running copy downloads a 404.

`desktop/release/` is gitignored, so a manifest from an abandoned build can
outlive the installer it names. The upload script refuses to run when
`release/latest.yml` and `package.json` disagree on the version; if that fires,
delete `desktop/release/` and build again.

First-time installs still need the `.exe` handed over directly — share
`desktop/release/TCB-Phone-Setup-<version>.exe`.

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
