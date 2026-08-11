"use strict";

const path = require("path");
const { app, BrowserWindow, shell, session, Tray, Menu, ipcMain, Notification } = require("electron");

// Single source of truth for the dashboard URL. If the worker is ever moved
// to a custom domain, update this one line.
const DASHBOARD_URL = "https://tcb-voip.phill-abb.workers.dev/admin/phone";

let mainWindow = null;
let tray = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "TCB Phone",
    autoHideMenuBar: true, // no custom menu items needed for a pure wrapper
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      preload: path.join(__dirname, "preload.js"),
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

  mainWindow.loadURL(DASHBOARD_URL);

  return mainWindow;
}

function createTray() {
  tray = new Tray(path.join(__dirname, "icon.png"));
  tray.setToolTip("TCB Phone");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show", click: () => mainWindow?.show() },
      { label: "Quit", click: () => app.quit() },
    ])
  );
  tray.on("click", () => mainWindow?.show());
}

// Renderer runs with contextIsolation/sandbox on, so it can't call Electron's
// Notification API directly -- preload.js bridges this one message through.
ipcMain.on("incoming-call", (_event, fromLabel) => {
  const notification = new Notification({ title: "Incoming call", body: fromLabel || "Unknown caller" });
  notification.on("click", () => mainWindow?.show());
  notification.show();
});

app.whenReady().then(() => {
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
});

app.on("window-all-closed", () => {
  // Softphone must stay reachable in the tray even with the window closed --
  // do not quit here. The window's own "close" handler hides rather than
  // destroys it, so this normally never fires; kept only in case a window is
  // ever destroyed some other way.
});
