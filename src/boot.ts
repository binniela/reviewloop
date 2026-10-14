import { Hono } from "hono";
import { createApp, type AppDeps } from "./app.js";
import { assertMigrated, migrate, openFromEnv, openPglite } from "./db.js";
import { seedDemo } from "./demo.js";
import { messengerFromEnv } from "./messaging.js";
import { drafterFromEnv } from "./reviews/drafter.js";
import { reviewSourceFromEnv } from "./reviews/sources.js";
import { validateRuntime } from "./runtime.js";

/**
 * Demo mode: an in-memory database seeded with two sample hotels, mock Google, printed messages,
 * and a demo/demo login. On by default for a Vercel deployment with no DATABASE_URL, so a fresh
 * deploy shows the product instead of crashing; set DATABASE_URL to run it for real.
 */
export const demoMode = (env = process.env) =>
  env.REVIEWLOOP_DEMO === "1" || (!!env.VERCEL && !env.DATABASE_URL && env.REVIEWLOOP_DEMO !== "0");

export async function buildDeps(env = process.env): Promise<AppDeps> {
  // Installer links on /welcome: https only, so a typo can't become a broken or unsafe link.
  const link = (u: string | undefined) => (u && /^https:\/\/[^\s"'<>]+$/.test(u.trim()) ? u.trim() : undefined);
  const deskIdleMinutes = Math.max(1, Number(env.DESK_IDLE_MINUTES) || 15);
  const downloads = { mac: link(env.DOWNLOAD_MAC_URL), windows: link(env.DOWNLOAD_WINDOWS_URL), chrome: link(env.DOWNLOAD_CHROME_URL) };
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
      deskIdleMinutes,
    };
  }
  validateRuntime(env);
  const db = await openFromEnv();
  if (env.DATABASE_URL) await assertMigrated(db);
  else await migrate(db);
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
    deskIdleMinutes,
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
