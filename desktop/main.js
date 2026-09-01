"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, dialog, shell, session, Tray, Menu, ipcMain, Notification, powerMonitor } = require("electron");
const { autoUpdater } = require("electron-updater");

// Single source of truth for the dashboard URL. If the worker is ever moved
// to a custom domain, update this one line.
const DASHBOARD_URL = "https://tcbvoip.app/admin/phone";

// Windows identity for the app: groups the taskbar button, attributes notifications, and must be
// stamped on any shortcut we create ourselves (see offerDesktopShortcut) or Windows treats a window
// launched from that shortcut as a different app.
const APP_USER_MODEL_ID = "au.com.tcbpestcontrolcanberra.tcbphone";

let mainWindow = null;
let tray = null;

// True when Windows auto-started us at login (we pass --hidden in the login-item
// args) OR when a manual "run hidden" is requested. In that case we bring the app
// up silently into the tray -- like a real desk phone that's simply always on --
// instead of popping a window in the user's face on every boot.
const startHidden =
  process.argv.includes("--hidden") || app.getLoginItemSettings().wasOpenedAtLogin === true;

// The app lives in the tray, so launching the shortcut again while it's hidden
// must surface the existing window -- NOT start a second instance sharing the
// same profile (which would register two Twilio Devices under one identity).
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on("second-instance", () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

// The app auto-starts at Windows login, which routinely beats the network being up. A single
// loadURL() that fails then leaves a blank white window forever -- Electron does not retry -- and
// the user sees "the app won't load". Retry with a short backoff until the dashboard actually loads.
let reloadTimer = null;
let reloadAttempt = 0;
const RELOAD_DELAYS_MS = [1000, 2000, 5000, 10000, 15000, 30000];

function loadDashboard() {
  if (reloadTimer) {
    clearTimeout(reloadTimer);
    reloadTimer = null;
  }
  mainWindow?.loadURL(DASHBOARD_URL).catch(() => {
    // loadURL rejects on failure too; did-fail-load also fires, and scheduleReload is
    // idempotent, so whichever arrives first wins and the other is a no-op.
    scheduleReload();
  });
}

function scheduleReload() {
  if (reloadTimer || !mainWindow || mainWindow.isDestroyed()) return;
  const delay = RELOAD_DELAYS_MS[Math.min(reloadAttempt, RELOAD_DELAYS_MS.length - 1)];
  reloadAttempt++;
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    loadDashboard();
  }, delay);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "TCB Phone",
    icon: path.join(__dirname, "icon.png"),
    // When auto-launched at login we come up straight into the tray (no window
    // flashes on the desktop); the page still loads and runs in the background,
    // keeping the softphone registered and notifications polling.
    show: !startHidden,
    autoHideMenuBar: true, // no custom menu items needed for a pure wrapper
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      preload: path.join(__dirname, "preload.js"),
      // The window spends most of its life hidden in the tray. Chromium's
      // intensive background throttling clamps hidden-page timers to ~1/min,
      // which risks starving the Twilio signaling keepalives -- the softphone
      // must stay registered while hidden, so throttling stays off.
      backgroundThrottling: false,
    },
  });

  // Any window.open()/target="_blank"/popup request is denied in Electron
  // and handed to the OS default browser instead. The dashboard has no
  // external links today, so this never fires in normal use — it's cheap
  // standard security practice against a page that could change in the
  // future, not a response to a current requirement.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Softphone must stay reachable while a call is ringing/active even if the
  // user closes the window, so intercept the close and hide to the tray
  // instead of letting Electron destroy the window. Gated on app.isQuitting
  // so the tray's "Quit" item (which calls app.quit()) still works --
  // app.quit() closes each window, which fires this same "close" event, so
  // without the gate the quit would be silently swallowed by the hide logic.
  mainWindow.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // ERR_ABORTED (-3) is the normal signature of a redirect superseding a load (the dashboard
  // bounces to /login when the session has expired), not a failure worth retrying.
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    console.warn(`dashboard load failed (${errorCode} ${errorDescription}) for ${validatedURL}; retrying`);
    scheduleReload();
  });

  // A successful load means the network is back -- reset the backoff so a later failure starts
  // retrying quickly again rather than waiting the maximum delay.
  mainWindow.webContents.on("did-finish-load", () => {
    reloadAttempt = 0;
  });

  // A crashed or killed renderer leaves the same blank window as a failed load.
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.warn(`renderer gone (${details.reason}); reloading`);
    scheduleReload();
  });

  loadDashboard();

  return mainWindow;
}

function rebuildTrayMenu() {
  if (!tray) return;
  const items = [
    { label: "Show", click: () => mainWindow?.show() },
    {
      label: "Reload",
      click: () => {
        reloadAttempt = 0;
        loadDashboard();
      },
    },
  ];
  if (updateReadyVersion) {
    items.push({ type: "separator" });
    items.push({ label: `Restart to update to ${updateReadyVersion}`, click: () => restartToUpdate() });
  }
  items.push({ type: "separator" });
  items.push({ label: `Version ${app.getVersion()}`, enabled: false });
  items.push({ label: "Quit", click: () => app.quit() });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function createTray() {
  tray = new Tray(path.join(__dirname, "tcb-logo.png"));
  tray.setToolTip("TCB Phone");
  rebuildTrayMenu();
  tray.on("click", () => mainWindow?.show());
}

// Renderer runs with contextIsolation/sandbox on, so it can't call Electron's
// Notification API directly -- preload.js bridges this one message through.
ipcMain.on("incoming-call", (_event, fromLabel) => {
  const notification = new Notification({ title: "Incoming call", body: fromLabel || "Unknown caller" });
  notification.on("click", () => mainWindow?.show());
  notification.show();
});

// The installer deliberately does NOT create a desktop shortcut (nsis.createDesktopShortcut is
// false); the app asks instead, so staff who only ever use the tray icon don't get an icon they
// didn't want. Asked exactly once -- a "no" is remembered forever rather than re-prompted on every
// launch -- via a small JSON file in userData, which is cheaper than a settings dependency for one
// boolean.
function prefsPath() {
  return path.join(app.getPath("userData"), "shell-prefs.json");
}

function readPrefs() {
  try {
    return JSON.parse(fs.readFileSync(prefsPath(), "utf8"));
  } catch (e) {
    // Missing on first run, and unreadable/corrupt is the same situation: nothing decided yet.
    return {};
  }
}

function writePrefs(prefs) {
  try {
    fs.writeFileSync(prefsPath(), JSON.stringify(prefs, null, 2));
  } catch (e) {
    // Non-fatal: worst case we ask again next launch, which beats failing to start.
    console.warn(`could not save shell prefs: ${e?.message ?? e}`);
  }
}

function desktopShortcutPath() {
  return path.join(app.getPath("desktop"), "TCB Phone.lnk");
}

async function offerDesktopShortcut() {
  // writeShortcutLink is Windows-only and a .lnk means nothing elsewhere; the installer only
  // targets Windows anyway.
  if (process.platform !== "win32") return;
  // In dev, process.execPath is the Electron binary under node_modules -- a shortcut to it would
  // launch a bare Electron rather than the app. Same reasoning as configureAutoLaunch().
  if (!app.isPackaged) return;
  // Auto-started at login we come up silently into the tray on purpose; a modal dialog at boot is
  // exactly the "window in the user's face" that startHidden exists to avoid. Ask on the next
  // launch the user actually initiates.
  if (startHidden) return;

  const prefs = readPrefs();
  if (prefs.desktopShortcutAsked) return;

  // A shortcut already on the desktop (installers before this change created one unconditionally)
  // leaves nothing to offer -- record it as settled so the question never comes up.
  if (fs.existsSync(desktopShortcutPath())) {
    writePrefs({ ...prefs, desktopShortcutAsked: true });
    return;
  }

  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "question",
    buttons: ["Add shortcut", "No thanks"],
    defaultId: 0,
    cancelId: 1,
    title: "TCB Phone",
    message: "Add a TCB Phone shortcut to your desktop?",
    detail:
      "TCB Phone starts automatically when you log in and sits in the notification area by the clock. " +
      "A desktop shortcut is only needed if you also want to open it yourself.",
  });

  // Record the answer either way -- the point of asking once is that "no" sticks.
  writePrefs({ ...prefs, desktopShortcutAsked: true });

  if (response !== 0) return;

  try {
    shell.writeShortcutLink(desktopShortcutPath(), "create", {
      target: process.execPath,
      cwd: path.dirname(process.execPath),
      description: "TCB Phone -- staff calls and message inbox",
      // The packaged .exe carries the app icon at index 0, so point at the binary rather than
      // shipping a separate .ico for the shortcut to reference.
      icon: process.execPath,
      iconIndex: 0,
      appUserModelId: APP_USER_MODEL_ID,
    });
  } catch (e) {
    // Non-fatal: a locked-down or redirected (OneDrive) desktop folder may refuse the write. The
    // app is already running; the user simply doesn't get the icon.
    console.warn(`could not create desktop shortcut: ${e?.message ?? e}`);
  }
}

// Make the phone app behave like a real desk phone: launch automatically when
// the user logs in, and come up hidden in the tray. Only in the packaged build
// -- during `npm start` dev we don't want to register a login item pointing at
// the Electron dev binary. Windows/macOS only; a no-op elsewhere.
function configureAutoLaunch() {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: true,
      // macOS honours openAsHidden directly; Windows ignores it, so we also pass
      // --hidden as a launch arg and key off that (see startHidden above).
      openAsHidden: true,
      args: ["--hidden"],
    });
  } catch (e) {
    // Non-fatal: a locked-down machine may refuse the login item. The app still
    // works, it just won't auto-start.
  }
}

// When the machine wakes from sleep, nudge the page to poll immediately so a
// missed call/text surfaces within a second or two instead of waiting for the
// next polling tick. (Nothing can be delivered *while* asleep -- no process
// runs -- so catching up on resume is the best achievable behaviour.)
function pollNow() {
  try {
    mainWindow?.webContents.executeJavaScript(
      "window.tcbNotifyPollNow && window.tcbNotifyPollNow();",
      true
    );
  } catch (e) {
    // Window may be gone; ignore.
  }
}

// Auto-update from GitHub Releases (the repo is public, so no token is needed). The app lives in
// the tray and is almost never quit deliberately, so waiting for a quit to apply an update would
// mean it effectively never updates: check on launch, then every six hours, and tell the user when
// a new version is ready so they can restart on their own terms.
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
let updateReadyVersion = null;

function setUpAutoUpdate() {
  // In dev there is no packaged app to replace, and electron-updater throws rather than no-ops.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  // Applied on quit; the tray notification below offers to restart immediately instead.
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-downloaded", (info) => {
    updateReadyVersion = info?.version ?? null;
    rebuildTrayMenu();
    const notification = new Notification({
      title: "TCB Phone update ready",
      body: updateReadyVersion
        ? `Version ${updateReadyVersion} will install when you restart. Click to restart now.`
        : "An update will install when you restart. Click to restart now.",
    });
    notification.on("click", () => restartToUpdate());
    notification.show();
  });

  // Never let an update problem take the phone down -- log and carry on.
  autoUpdater.on("error", (err) => {
    console.warn(`auto-update failed: ${err?.message ?? err}`);
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, UPDATE_CHECK_INTERVAL_MS);
}

function restartToUpdate() {
  app.isQuitting = true;
  autoUpdater.quitAndInstall();
}

app.whenReady().then(() => {
  // Windows groups taskbar buttons and attributes notifications by this ID.
  // Set it to the packaged appId so the app shows as "TCB Phone" with its own
  // icon rather than being grouped under the generic Electron identity.
  app.setAppUserModelId(APP_USER_MODEL_ID);

  configureAutoLaunch();
  powerMonitor.on("resume", pollNow);
  powerMonitor.on("unlock-screen", pollNow);

  // The softphone needs mic access to place/receive calls via the Twilio
  // Voice SDK. Electron blocks all permission requests by default, so this
  // grants only "media" (mic/cam) and denies everything else. `session` is
  // only available once the app is ready, so this must run here, not at
  // module load time -- and it must run before createWindow() so the
  // handler is registered before the page's own getUserMedia() call.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === "media");
  });

  createWindow();
  createTray();
  setUpAutoUpdate();

  // Ask about the shortcut only once the dashboard is actually up: at login the load retries with
  // backoff, and a dialog stacked on a blank window would be asking about an app the user cannot
  // yet see working. `once` means the first successful load wins, not every later reload.
  mainWindow?.webContents.once("did-finish-load", () => {
    offerDesktopShortcut().catch((e) => {
      console.warn(`desktop shortcut prompt failed: ${e?.message ?? e}`);
    });
  });

  app.on("activate", () => {
    // macOS-only pattern (re-create a window when the dock icon is clicked
    // with no windows open). Harmless no-op on Windows; included because
    // it's standard Electron boilerplate and costs nothing to keep.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      mainWindow?.show();
    }
  });
});

app.on("before-quit", () => {
  // Runs before app.quit() closes any windows, so the flag is already set
  // by the time the "close" handler above checks it.
  app.isQuitting = true;
  // Best-effort: flip presence to offline so the ring roster drops this agent
  // immediately instead of ringing a dead endpoint until the 5-minute
  // heartbeat staleness threshold expires. Runs in the page context (which
  // holds the Access session cookies); keepalive lets the request survive
  // page teardown. Fire-and-forget -- quitting must never hang on it.
  try {
    mainWindow?.webContents.executeJavaScript(
      "fetch('/api/softphone/presence',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'offline',awayReason:null}),keepalive:true}).catch(function(){})",
      true
    );
  } catch (e) {
    // Window may already be destroyed; nothing to do.
  }
});

app.on("window-all-closed", () => {
  // Softphone must stay reachable in the tray even with the window closed --
  // do not quit here. The window's own "close" handler hides rather than
  // destroys it, so this normally never fires; kept only in case a window is
  // ever destroyed some other way.
});
