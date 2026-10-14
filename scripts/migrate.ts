import { migrate, openFromEnv } from "../src/db.js";

// Load .env if present (Node 20.12+).
try {
  process.loadEnvFile();
} catch {}

if (process.env.DATABASE_URL && new URL(process.env.DATABASE_URL).port === "6543") {
  throw new Error("Use a direct or session-pooler Postgres URL for migrations, not a transaction-pooler URL on port 6543");
}
const db = await openFromEnv();
const ran = await migrate(db);
console.log(ran.length ? `applied: ${ran.join(", ")}` : "up to date");
await db.close();
