import { migrate, openFromEnv } from "../src/db.js";

// Load .env if present (Node 20.12+).
try {
  process.loadEnvFile();
} catch {}

const db = await openFromEnv();
const ran = await migrate(db);
console.log(ran.length ? `applied: ${ran.join(", ")}` : "up to date");
await db.close();
