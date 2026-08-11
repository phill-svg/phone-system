"use strict";

// Runs in the isolated preload context (contextIsolation: true, nodeIntegration:
// false) so it can bridge a narrow, explicit API onto window without exposing
// Node/Electron internals to the dashboard page itself.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopBridge", {
  notifyIncomingCall: (fromLabel) => ipcRenderer.send("incoming-call", fromLabel),
});
