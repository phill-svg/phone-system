# TCB Phone — Electron desktop wrapper — design

## Problem

Staff currently reach the VoIP admin dashboard (`https://tcb-voip.phill-abb.workers.dev/`, gated behind Cloudflare Access email-OTP login) by finding/bookmarking the URL in a browser. The ask is a downloadable Windows app giving staff a real desktop icon that launches straight into the dashboard — purely for easier access, explicitly not for native OS integration (no system tray, no notifications, no auto-launch-on-boot).

## Scope

A minimal Electron shell: one `BrowserWindow` loading the live dashboard URL, nothing more. No offline mode, no local data, no custom renderer code, no IPC surface. Lives in a new `desktop/` subfolder of this repo, as its own self-contained Node package (not part of any monorepo/workspace tooling — this repo has none).

Out of scope: native OS integration, code signing, auto-update infrastructure, any change to the worker itself.

## Distribution model

Build the installer locally with electron-builder, manually upload the `.exe` to a GitHub Release on this repo (phill-svg/phone-system), share the link with staff. No auto-update: since the app only displays the always-current live URL, dashboard changes need zero app updates — only a shell-code change (e.g. an Electron version bump) would ever require re-distributing.

The installer is unsigned (no code-signing budget). Windows SmartScreen will show an "unrecognized publisher" warning on first run; this is an accepted, known tradeoff, documented in `desktop/README.md` for whoever hands out the download link.

App name (window title, desktop shortcut, Start Menu entry): **"TCB Phone"**.

## Design

### File structure

```
desktop/
  package.json      # own manifest, own devDependencies, no "type": "module"
  package-lock.json  # generated, committed
  main.js            # Electron main process (CommonJS)
  README.md           # build/run/distribute instructions
```

No preload script — no IPC needs, the app has zero custom renderer code. No icon asset for v1 — none exists in the repo; electron-builder falls back to its default Electron icon. No separate `electron-builder.yml` — config is short enough to inline in `package.json`.

`main.js` is CommonJS, not ESM, even though the root package has `"type": "module"` — this only applies within `desktop/`, which has its own `package.json` with no `"type"` field (defaults to CommonJS). Simpler and more battle-tested with electron-builder than main-process ESM.

### `desktop/package.json`

Key fields: `name: "tcb-phone-desktop"`, `main: "main.js"`, scripts `start` (`electron .`), `build` (`electron-builder --win --x64`), `build:dir` (unpacked dir build for quick iteration). `devDependencies`: `electron`, `electron-builder` — installed via `npm install --save-dev electron@latest electron-builder@latest` and the resolved versions committed (don't hand-guess version numbers).

Inline `"build"` config: `appId: "au.com.tcbpestcontrolcanberra.tcbphone"`, `productName: "TCB Phone"`, `files: ["main.js", "package.json"]` (no runtime deps, so nothing else needs packing), `directories.output: "release"`, Windows NSIS target (x64), `nsis.perMachine: false` (per-user install, no admin rights required), `nsis.oneClick: true` (single-click install, friendliest for non-technical staff), `createDesktopShortcut`/`createStartMenuShortcut: true`, `artifactName: "TCB-Phone-Setup-${version}.exe"`.

### `desktop/main.js`

Creates one `BrowserWindow` (1280×800, min 800×600, title "TCB Phone", menu bar auto-hidden) with security defaults `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webviewTag: false`, loading `https://tcb-voip.phill-abb.workers.dev/` directly via `loadURL`.

`setWindowOpenHandler` denies any `window.open()`/popup request and hands it to the OS default browser via `shell.openExternal` instead — cheap standard security practice against a page that could change in the future (the dashboard has no external links today).

Standard Electron lifecycle boilerplate: `app.whenReady()` creates the window, `activate` re-creates one if none exist (macOS pattern, harmless no-op on Windows), `window-all-closed` quits the app on non-macOS (this app is Windows-only in practice, so this always fully quits on window close — no tray, no background process, per scope).

**Deliberately no origin-lock on navigation.** Cloudflare Access's email-OTP login redirects the same window through `phill-abb.cloudflareaccess.com` and back to the worker origin before landing on `/admin/live`. A `will-navigate` handler restricting navigation to the worker's own origin would silently break login — and would look fine in a warm/already-authenticated test, which is why the verification plan mandates a cold-login check specifically. Given the actual threat model (one hardcoded trusted URL, already gated behind Access, no user-generated content ever loaded), an origin allowlist's marginal benefit doesn't justify the risk of getting it wrong later (e.g. Access moving to a different subdomain). `setWindowOpenHandler` alone covers the realistic risk.

### `.gitignore`

Add `desktop/release/` to the root `.gitignore`. (`node_modules/` already covers `desktop/node_modules/` at any depth — no new rule needed there.)

### Documentation

`desktop/README.md`: build/run instructions, distribution steps (build → upload to GitHub Releases → share link), and an explicit heads-up for whoever shares the download link about the SmartScreen warning and what to tell staff.

Root `README.md`: short "Desktop app" section pointing at `desktop/README.md`, plus one line added to the existing `## Project structure` block.

## Testing

No automated tests for v1 — a two-file shell with no business logic; a Spectron/Playwright smoke test would mostly test that Electron itself can load a URL. Revisit if the app grows real logic later.

Manual verification checklist (documented in full in the implementation plan): install deps, run in dev mode, **cold-login check** (delete the app's userData folder first — this is the test that actually exercises the Access OTP redirect, since a warm/logged-in session would skip it entirely and hide a broken redirect handler), resize/close behavior, build the installer, install/run/uninstall on a clean profile.

## Out of scope / follow-ups

- Native OS integration (tray, notifications, auto-launch) — explicitly rejected for v1.
- Code signing — no budget; SmartScreen warning is accepted.
- Auto-update — not needed given the shell has no content of its own to go stale.
- A custom app icon — ships with Electron's default for v1; add later via `build.win.icon` when a branding asset exists.
