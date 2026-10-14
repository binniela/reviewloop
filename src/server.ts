import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { buildDeps, createApp, withStatic } from "./boot.js";

// Load .env if present (Node 20.12+).
try {
  process.loadEnvFile();
} catch {}

const deps = await buildDeps();
if (process.env.REVIEWLOOP_DEMO === "1") console.warn("Demo mode: in-memory sample hotels. Sign in with demo / demo.");
else {
  if (!deps.adminPassword) console.warn("ADMIN_PASSWORD not set: the staff UI is open. Fine locally, not in production.");
  if (!deps.publicUrl) console.warn("PUBLIC_URL not set: Twilio webhooks will be rejected and alert links will be relative.");
  if (process.env.MESSAGING_MODE !== "live") console.warn("MESSAGING_MODE is not 'live': guest messages are printed, not sent.");
}

const port = Number(process.env.PORT ?? 3000);
const app = withStatic(createApp(deps), serveStatic({ root: "./public" }));
serve({ fetch: app.fetch, port }, () => console.log(`Reviewloop on http://localhost:${port}`));

// Local scheduler. In production, call GET /cron/tick from a cron (Vercel Cron, Supabase pg_cron, etc.).
if (process.env.LOCAL_TICK_SECONDS) {
  const { tick } = await import("./app.js");
  setInterval(() => tick(deps).catch((e) => console.error("tick failed", e)), Number(process.env.LOCAL_TICK_SECONDS) * 1000);
}
