// The only bridge between web pages and the app. The console calls setBadge with the number of
// issues nobody has taken; the local setup and offline pages use setServer and retry.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("reviewloopDesktop", {
  platform: process.platform,
  setBadge: (n) => ipcRenderer.send("badge", Number(n) || 0),
  setServer: (url) => ipcRenderer.invoke("set-server", String(url)),
  retry: () => ipcRenderer.send("retry"),
});
