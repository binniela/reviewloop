// Reviewloop desktop (macOS, Windows). A native window around the hosted console: the console
// itself runs on your server (Vercel or anywhere), so the desk PC and the GM's laptop see the
// same issues. The app adds a dock/taskbar badge, native notifications, and opens at login.
const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, nativeTheme, shell } = require("electron");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const BUNDLED = readJson(join(__dirname, "app-config.json"), { serverUrl: "", demoUrl: "" });
const SETTINGS = () => join(app.getPath("userData"), "settings.json");
let win = null;
let lastBadge = 0;

function readJson(path, fallback) {
  try {
    return existsSync(path) ? { ...fallback, ...JSON.parse(readFileSync(path, "utf8")) } : fallback;
  } catch {
    return fallback;
  }
}
const settings = () => readJson(SETTINGS(), { serverUrl: BUNDLED.serverUrl });
const saveSettings = (s) => writeFileSync(SETTINGS(), JSON.stringify({ ...settings(), ...s }, null, 2));
const serverOrigin = () => {
  try {
    return settings().serverUrl ? new URL(settings().serverUrl).origin : null;
  } catch {
    return null;
  }
};

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});
if (process.platform === "win32") app.setAppUserModelId("com.reviewloop.desktop");

function openConsole(path = "/issues") {
  const origin = serverOrigin();
  if (!origin) return win.loadFile(join(__dirname, "pages", "setup.html"), { query: { demo: BUNDLED.demoUrl } });
  return win.loadURL(origin + path);
}

function createWindow() {
  const mac = process.platform === "darwin";
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 380,
    minHeight: 560,
    title: "Reviewloop",
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#171512" : "#FBFAF7",
    titleBarStyle: mac ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 14 },
    autoHideMenuBar: !mac,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  win.once("ready-to-show", () => win.show());

  // Stay on the hotel's server; everything else (Google review links, docs) opens in the browser.
  const allowed = (url) => url.startsWith("file:") || (serverOrigin() && new URL(url).origin === serverOrigin());
  win.webContents.on("will-navigate", (e, url) => {
    if (!allowed(url)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("did-fail-load", (_e, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3: navigation aborted (a redirect), not an error
    win.loadFile(join(__dirname, "pages", "offline.html"), { query: { url } });
  });
  win.on("focus", () => win.flashFrame(false));
  win.on("closed", () => (win = null));
  openConsole();
}

// The console reports the number of issues nobody has taken (see STAFF_JS in src/web/layout.ts).
ipcMain.on("badge", (_e, n) => {
  const count = Math.max(0, Math.min(999, Number(n) || 0));
  if (process.platform === "win32" && win) {
    const dot = nativeImage.createFromPath(join(__dirname, "build", "badge.png"));
    win.setOverlayIcon(count ? dot : null, count ? `${count} guest issues waiting` : "");
  } else {
    app.setBadgeCount(count);
  }
  if (count > lastBadge && win && !win.isFocused()) win.flashFrame(true);
  lastBadge = count;
});

// Only the app's own local pages (setup, offline) may change the server or retry.
const local = (e) => (e.senderFrame?.url ?? "").startsWith("file:");

ipcMain.handle("set-server", (e, url) => {
  if (!local(e)) throw new Error("not allowed");
  const origin = new URL(/^https?:\/\//.test(url) ? url : `https://${url}`).origin;
  saveSettings({ serverUrl: origin });
  openConsole();
  return origin;
});

ipcMain.on("retry", (e) => local(e) && openConsole());

async function changeServer() {
  if (!win) return;
  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    buttons: ["Change address", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    message: "Connect to a different Reviewloop server?",
    detail: `Currently: ${serverOrigin() ?? "not set"}`,
  });
  if (response !== 0) return;
  saveSettings({ serverUrl: "" });
  openConsole();
}

function buildMenu() {
  const mac = process.platform === "darwin";
  const go = (path) => () => win && openConsole(path);
  const loginItem = {
    label: "Open at Login",
    type: "checkbox",
    checked: app.getLoginItemSettings().openAtLogin,
    click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
  };
  const template = [
    ...(mac
      ? [{ label: app.name, submenu: [{ role: "about" }, { type: "separator" }, loginItem, { label: "Change Server…", click: changeServer }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] }]
      : [{ label: "File", submenu: [loginItem, { label: "Change Server…", click: changeServer }, { type: "separator" }, { role: "quit" }] }]),
    { role: "editMenu" },
    {
      label: "Go",
      submenu: [
        { label: "Guest Issues", accelerator: "CmdOrCtrl+1", click: go("/issues") },
        { label: "Review Replies", accelerator: "CmdOrCtrl+2", click: go("/") },
        { label: "Pilot Metrics", accelerator: "CmdOrCtrl+3", click: go("/metrics") },
        { label: "Upload Report", accelerator: "CmdOrCtrl+4", click: go("/upload") },
        { label: "Check-in QR", accelerator: "CmdOrCtrl+5", click: go("/setup") },
        { type: "separator" },
        { label: "Back", accelerator: "CmdOrCtrl+[", click: () => win?.webContents.navigationHistory.goBack() },
        { label: "Forward", accelerator: "CmdOrCtrl+]", click: () => win?.webContents.navigationHistory.goForward() },
      ],
    },
    { label: "View", submenu: [{ role: "reload" }, { role: "forceReload" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }, ...(app.isPackaged ? [] : [{ role: "toggleDevTools" }])] },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on("activate", () => {
    if (!win) createWindow();
  });
});

// The desk keeps it open all day: closing the window on macOS leaves the app (and badge) running.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
