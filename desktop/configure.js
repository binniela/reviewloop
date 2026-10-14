// Writes app-config.json for a build. The server URL is what the app opens on first launch;
// people can change it later from the app menu. Usage:
//   REVIEWLOOP_URL=https://reviewloop.yourhotel.com npm run dist
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

const clean = (u) => (u ? new URL(u).origin : "");
const config = {
  serverUrl: clean(process.env.REVIEWLOOP_URL),
  demoUrl: clean(process.env.REVIEWLOOP_DEMO_URL),
};
writeFileSync(join(__dirname, "app-config.json"), JSON.stringify(config, null, 2) + "\n");
console.log("app-config.json", config);
