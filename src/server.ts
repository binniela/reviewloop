import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { migrate, openFromEnv } from "./db.js";
import { drafterFromEnv } from "./reviews/drafter.js";
import { messengerFromEnv } from "./messaging.js";
import { reviewSourceFromEnv } from "./reviews/sources.js";

const db = await openFromEnv();
await migrate(db);

const deps = {
  db,
  messenger: messengerFromEnv(),
  source: reviewSourceFromEnv(),
  drafter: drafterFromEnv(),
  adminUser: process.env.ADMIN_USER,
  adminPassword: process.env.ADMIN_PASSWORD,
  cronSecret: process.env.CRON_SECRET,
};
if (!deps.adminPassword) console.warn("ADMIN_PASSWORD not set: the staff UI is open. Fine locally, not in production.");
if (process.env.MESSAGING_MODE !== "live") console.warn("MESSAGING_MODE is not 'live': guest messages are printed, not sent.");

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: createApp(deps).fetch, port }, () => console.log(`Reviewloop on http://localhost:${port}`));

// Local scheduler. In production, call GET /cron/tick from a cron (Vercel Cron, Supabase pg_cron, etc.).
if (process.env.LOCAL_TICK_SECONDS) {
  const { tick } = await import("./app.js");
  setInterval(() => tick(deps).catch((e) => console.error("tick failed", e)), Number(process.env.LOCAL_TICK_SECONDS) * 1000);
}
