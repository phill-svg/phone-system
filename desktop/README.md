# TCB Phone — Desktop App

A thin Electron wrapper around the TCB VoIP staff admin dashboard
(https://tcbvoip.app/). It's just a window pointed at the live site — no offline mode, no local
data. All feature and content changes ship through the worker itself and need no app update; only a
shell-level change (e.g. bumping the Electron version) needs a new installer.

Those shell-level changes do reach staff on their own: the app auto-updates via electron-updater,
checking on launch and every six hours. See *Shipping an update* below.

## Building the installer

```bash
cd desktop
npm install
npm run build
```

This produces `desktop/release/TCB-Phone-Setup-<version>.exe`.

## Shipping an update

Bump `version` in `desktop/package.json` first — electron-updater compares versions, so an
unbumped build is invisible to everyone already running the app. Then:

```bash
cd desktop
npm run build            # release/TCB-Phone-Setup-<version>.exe + .blockmap + latest.yml
npm run release:upload   # puts all three in R2 under desktop/, manifest last
```

`release:upload` needs `wrangler` to be logged in to the Cloudflare account. Running copies pick
the update up within six hours, or immediately on their next launch; staff get a notification
offering to restart, and it applies on quit either way.

**First install for someone new** still needs the `.exe` handed over directly — share
`release/TCB-Phone-Setup-<version>.exe`, or the `https://tcbvoip.app/desktop/` URL it was uploaded
to.

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
