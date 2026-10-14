// Dev check: launches the real app against a running server, signs in to the demo, and saves
// screenshots. Run: REVIEWLOOP_URL=http://localhost:3017 npx electron smoke.js <out-dir>
const { app } = require("electron");
const { writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

const out = process.argv[2] || join(__dirname, "smoke-out");
mkdirSync(out, { recursive: true });
const settingsFile = () => join(app.getPath("userData"), "settings.json");
app.setPath("userData", join(out, "profile"));
app.whenReady().then(() => writeFileSync(settingsFile(), JSON.stringify({ serverUrl: process.env.REVIEWLOOP_URL || "" })));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.on("browser-window-created", async (_e, win) => {
  const shot = async (name) => writeFileSync(join(out, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const log = [];
  try {
    await new Promise((r) => win.webContents.once("did-finish-load", r));
    await wait(800);
    log.push(["first page", win.webContents.getURL()]);
    await shot("1-first");
    if (win.webContents.getURL().includes("/login")) {
      await win.webContents.executeJavaScript(`
        document.querySelector('[name=user]').value = 'demo';
        document.querySelector('[name=password]').value = 'demo';
        document.querySelector('form').submit();`);
      await new Promise((r) => win.webContents.once("did-finish-load", r));
      await wait(2500);
    }
    log.push(["after sign-in", win.webContents.getURL()]);
    log.push(["desktop bridge", await win.webContents.executeJavaScript("document.documentElement.className")]);
    log.push(["badge count", app.getBadgeCount()]);
    await shot("2-issues");
  } catch (err) {
    log.push(["error", String(err)]);
  }
  console.log(JSON.stringify(log, null, 1));
  app.quit();
});

require("./main.js");
