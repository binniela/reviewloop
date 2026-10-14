import { Hono } from "hono";
import { createApp, type AppDeps } from "./app.js";
import { migrate, openFromEnv, openPglite } from "./db.js";
import { seedDemo } from "./demo.js";
import { messengerFromEnv } from "./messaging.js";
import { drafterFromEnv } from "./reviews/drafter.js";
import { reviewSourceFromEnv } from "./reviews/sources.js";
import { log } from "./log.js";
import { validateRuntime } from "./runtime.js";

/**
 * Demo mode: an in-memory database seeded with two sample hotels, mock Google, printed messages,
 * and a demo/demo login. On by default for Vercel preview deployments with no DATABASE_URL, so a
 * branch deploy shows the product instead of crashing. A production deployment must ask for it
 * with REVIEWLOOP_DEMO=1: a hotel's console silently turning into a demo/demo sandbox because
 * DATABASE_URL went missing would lose every guest text sent to it.
 */
export const demoMode = (env = process.env) =>
  env.REVIEWLOOP_DEMO === "1" ||
  (!!env.VERCEL && !env.DATABASE_URL && env.REVIEWLOOP_DEMO !== "0" && env.VERCEL_ENV !== "production");

export async function buildDeps(env = process.env): Promise<AppDeps> {
  const downloads = { mac: env.DOWNLOAD_MAC_URL, windows: env.DOWNLOAD_WINDOWS_URL, chrome: env.DOWNLOAD_CHROME_URL };
  if (demoMode(env)) {
    env.REVIEWLOOP_DEMO = "1";
    const db = await openPglite();
    await migrate(db);
    const source = await seedDemo(db);
    return {
      db,
      source,
      messenger: messengerFromEnv({ ...env, MESSAGING_MODE: "console" }),
      drafter: drafterFromEnv(env),
      adminUser: "demo",
      adminPassword: "demo",
      cronSecret: env.CRON_SECRET,
      publicUrl: env.PUBLIC_URL,
      downloads,
      schedulerExpected: false,
    };
  }
  validateRuntime(env);
  const started = performance.now();
  const db = await openFromEnv();
  const ran = await migrate(db);
  log.info("boot", { env: env.VERCEL_ENV ?? env.NODE_ENV ?? "development", migrationsRan: ran, ms: Math.round(performance.now() - started) });
  return {
    db,
    messenger: messengerFromEnv(env),
    source: reviewSourceFromEnv(env),
    drafter: drafterFromEnv(env),
    adminUser: env.ADMIN_USER,
    adminPassword: env.ADMIN_PASSWORD,
    cronSecret: env.CRON_SECRET,
    twilioAuthToken: env.TWILIO_AUTH_TOKEN,
    publicUrl: env.PUBLIC_URL,
    allowUnsignedWebhooks: env.ALLOW_UNSIGNED_WEBHOOKS === "1",
    downloads,
    monitorToken: env.MONITOR_TOKEN,
  };
}

/** The app plus anything an entry point layers on top (static files locally). */
export function withStatic(app: Hono<any>, staticMw?: Parameters<Hono["use"]>[1]) {
  if (!staticMw) return app;
  const root = new Hono();
  root.use("/*", staticMw);
  root.route("/", app);
  return root;
}

export { createApp };
