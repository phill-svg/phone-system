"use strict";

const { app, BrowserWindow, shell } = require("electron");

// Single source of truth for the dashboard URL. If the worker is ever moved
// to a custom domain, update this one line.
const DASHBOARD_URL = "https://tcb-voip.phill-abb.workers.dev/";

function createWindow() {
  const win = new BrowserWindow({
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
    },
  });

  // Any window.open()/target="_blank"/popup request is denied in Electron
  // and handed to the OS default browser instead. The dashboard has no
  // external links today, so this never fires in normal use — it's cheap
  // standard security practice against a page that could change in the
  // future, not a response to a current requirement.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.loadURL(DASHBOARD_URL);

  return win;
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    // macOS-only pattern (re-create a window when the dock icon is clicked
    // with no windows open). Harmless no-op on Windows; included because
    // it's standard Electron boilerplate and costs nothing to keep.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  // Standard cross-platform pattern: quit on all-windows-closed everywhere
  // except macOS. This app is Windows-only in practice, so this always
  // quits the app when the window is closed — no tray, no background
  // process, per the "pure wrapper" scope decision.
  if (process.platform !== "darwin") {
    app.quit();
  }
});
