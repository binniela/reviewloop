// Import an ASI report from the command line:
//   npm run ingest -- <propertyId> <arrivals|in_house|departures|reservations> <file.csv>
import { readFile } from "node:fs/promises";
import { ingest } from "../src/app.js";
import { migrate, openFromEnv } from "../src/db.js";
import { REPORT_KINDS, type ReportKind } from "../src/ingest/asiReport.js";
import { messengerFromEnv } from "../src/messaging.js";
import { drafterFromEnv } from "../src/reviews/drafter.js";
import { reviewSourceFromEnv } from "../src/reviews/sources.js";

// Load .env if present (Node 20.12+).
try {
  process.loadEnvFile();
} catch {}

const [propertyId, kind, file] = process.argv.slice(2);
if (!propertyId || !file || !REPORT_KINDS.includes(kind as ReportKind)) {
  throw new Error(`usage: npm run ingest -- <propertyId> <${REPORT_KINDS.join("|")}> <file.csv>`);
}
const db = await openFromEnv();
await migrate(db);
const res = await ingest(
  { db, messenger: messengerFromEnv(), source: reviewSourceFromEnv(), drafter: drafterFromEnv() },
  propertyId,
  kind as ReportKind,
  await readFile(file, "utf8"),
);
console.log(JSON.stringify(res, null, 2));
await db.close();
