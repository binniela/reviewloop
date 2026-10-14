import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bearerMatches, createApp, tick, type AppDeps } from "../src/app.js";
import { demoMode } from "../src/boot.js";
import { migrate, openPglite, openPostgres, pendingMigrations, withoutSslMode, type Db } from "../src/db.js";
import { seedDemo } from "../src/demo.js";
import { ConsoleMessenger } from "../src/messaging.js";
import { TemplateDrafter } from "../src/reviews/drafter.js";
import { MockReviewSource } from "../src/reviews/sources.js";
import { validateRuntime } from "../src/runtime.js";
import { acquireLease, lastTick } from "../src/scheduler.js";
import { testDb } from "./helpers.js";

const NOW = new Date("2026-10-14T19:00:00Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const MIN = 60_000;

async function setup(extra: Partial<AppDeps> = {}) {
  const db = await testDb();
  let now = NOW;
  const deps: AppDeps = {
    db,
    messenger: new ConsoleMessenger(true),
    source: new MockReviewSource({ sunset: [] }),
    drafter: new TemplateDrafter(),
    cronSecret: "cron-secret",
    now: () => now,
    ...extra,
  };
  return { db, deps, app: createApp(deps), setNow: (d: Date) => (now = d) };
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
type AlertsBody = { ok: boolean; alerts: { code: string; severity: string; title: string }[] };

describe("migrations", () => {
  it("are a no-op the second time and report nothing pending", async () => {
    const db = await openPglite();
    expect((await pendingMigrations(db)).length).toBeGreaterThan(0);
    expect((await migrate(db)).length).toBeGreaterThan(0);
    expect(await migrate(db)).toEqual([]);
    expect(await pendingMigrations(db)).toEqual([]);
  });

  it("turn on row level security for every table, so Supabase's REST API exposes nothing", async () => {
    const db = await openPglite();
    await migrate(db);
    const open = await db.query("select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = current_schema() and relkind = 'r' and not relrowsecurity");
    expect(open).toEqual([]);
    // The app is the table owner, so its own queries still work.
    await db.query("insert into sync_state (key, value) values ('x', 'y')");
    expect(await db.query("select value from sync_state where key = 'x'")).toEqual([{ value: "y" }]);
  });

  // Real Postgres only (CI's service container, or TEST_DATABASE_URL locally): PGlite has one
  // connection, so it can't reproduce two serverless instances migrating at the same moment.
  it.skipIf(!process.env.TEST_DATABASE_URL)("survive several instances cold-starting at once", async () => {
    const schema = `rl_test_${randomUUID().slice(0, 8)}`;
    const admin = await openPostgres(process.env.TEST_DATABASE_URL!);
    await admin.query(`create schema ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const instances = await Promise.all([1, 2, 3, 4].map(() => openPostgres(url.toString())));
    try {
      const results = await Promise.all(instances.map((db) => migrate(db)));
      // Exactly one instance applied each file; the others waited, then found nothing to do.
      expect(results.flat().sort()).toEqual([...new Set(results.flat())].sort());
      expect(await pendingMigrations(instances[0]!)).toEqual([]);
    } finally {
      await Promise.all(instances.map((db) => db.close()));
      await admin.query(`drop schema ${schema} cascade`);
      await admin.close();
    }
  });
});

describe("tick lease and heartbeat", () => {
  it("lets one holder in at a time and frees up when released or expired", async () => {
    const db = await testDb();
    const release = await acquireLease(db, "tick", 2 * MIN, NOW);
    expect(release).not.toBeNull();
    expect(await acquireLease(db, "tick", 2 * MIN, at(MIN))).toBeNull();
    // A crashed holder never releases; its lease expires.
    expect(await acquireLease(db, "tick", 2 * MIN, at(3 * MIN))).not.toBeNull();
    const db2 = await testDb();
    const r2 = await acquireLease(db2, "tick", 2 * MIN, NOW);
    await r2!();
    expect(await acquireLease(db2, "tick", 2 * MIN, NOW)).not.toBeNull();
  });

  it("skips a tick that overlaps a running one, without doing any work", async () => {
    const { db, deps } = await setup();
    const release = await acquireLease(db, "tick", 2 * MIN, NOW);
    expect(await tick(deps)).toEqual({ skipped: true, reason: "another tick is running" });
    expect(await lastTick(db)).toBeNull();
    await release!();
    expect("skipped" in (await tick(deps))).toBe(false);
  });

  it("records each run, and keeps the last success when a run fails", async () => {
    const source = new MockReviewSource({ sunset: [] });
    const { db, deps, setNow } = await setup({ source });
    await tick(deps);
    expect(await lastTick(db)).toMatchObject({ ok: true, startedAt: NOW.toISOString(), lastOkAt: NOW.toISOString() });

    source.supports = () => { throw new Error("boom"); };
    setNow(at(5 * MIN));
    await expect(tick(deps)).rejects.toThrow("boom");
    expect(await lastTick(db)).toMatchObject({ ok: false, error: "boom", lastOkAt: NOW.toISOString() });
    // The lease was released even though the tick threw.
    expect(await acquireLease(db, "tick", 2 * MIN, at(5 * MIN))).not.toBeNull();
  });
});

describe("/health", () => {
  it("is public and reports the database and migrations", async () => {
    const { app } = await setup({ adminPassword: "pw" });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, database: "ok", migrations: "current" });
  });

  it("returns 503 when the database can't be reached", async () => {
    const { deps } = await setup();
    const broken: Db = { ...deps.db, query: async () => { throw new Error("connection refused"); } };
    const res = await createApp({ ...deps, db: broken }).request("/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, database: "unreachable" });
  });
});

describe("/health/alerts", () => {
  it("needs the monitor token or the cron secret", async () => {
    const { app } = await setup({ monitorToken: "mon" });
    expect((await app.request("/health/alerts")).status).toBe(401);
    expect((await app.request("/health/alerts", { headers: bearer("wrong") })).status).toBe(401);
    expect((await app.request("/health/alerts", { headers: bearer("mon") })).status).not.toBe(401);
    expect((await app.request("/health/alerts", { headers: bearer("cron-secret") })).status).not.toBe(401);
  });

  it("goes critical when the scheduler stops, and clears when it runs", async () => {
    const { app, deps, setNow } = await setup();
    let res = await app.request("/health/alerts", { headers: bearer("cron-secret") });
    expect(res.status).toBe(503);
    expect(((await res.json()) as AlertsBody).alerts.map((a) => a.code)).toEqual(["scheduler_stale"]);

    await tick(deps);
    res = await app.request("/health/alerts", { headers: bearer("cron-secret") });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, alerts: [] });

    setNow(at(16 * MIN));
    res = await app.request("/health/alerts", { headers: bearer("cron-secret") });
    expect(res.status).toBe(503);
    expect(((await res.json()) as AlertsBody).alerts[0]!.title).toBe("Scheduled work isn’t running");
  });

  it("flags a failing Google sync: a warning at first, critical after six hours without a success", async () => {
    const source = new MockReviewSource({ sunset: [] });
    const { app, deps, setNow } = await setup({ source });
    await tick(deps); // a success, so lastOk is set
    source.fetchReviews = async () => { throw new Error("invalid_grant: Token has been expired or revoked."); };
    const check = async () => ((await (await app.request("/health/alerts", { headers: bearer("cron-secret") })).json()) as AlertsBody).alerts.find((a) => a.code === "google_sync_failing");

    setNow(at(5 * MIN));
    await tick(deps);
    expect(await check()).toMatchObject({ severity: "warning" });
    setNow(at(6 * 60 * MIN + 10 * MIN));
    await tick(deps);
    expect(await check()).toMatchObject({ severity: "critical" });
  });

  it("says the same thing as the Operations page and the sidebar count", async () => {
    const db = await openPglite();
    await migrate(db);
    const source = await seedDemo(db, NOW);
    // Seeding runs a tick at NOW; twenty minutes on, with no cron calling, the scheduler is stale.
    const later = at(20 * MIN);
    const deps: AppDeps = { db, source, messenger: new ConsoleMessenger(true), drafter: new TemplateDrafter(), now: () => later, cronSecret: "cron-secret" };
    const app = createApp(deps);
    await db.query(
      "update recovery_cases set escalation_error = 'Twilio 20003: Authenticate' where id = (select min(id) from recovery_cases where resolved_at is null)",
    );
    const body = (await (await app.request("/health/alerts", { headers: bearer("cron-secret") })).json()) as AlertsBody;
    const codes = body.alerts.map((a) => a.code);
    expect(codes).toContain("escalations_failing");
    expect(codes).toContain("scheduler_stale");
    expect(body.ok).toBe(false);

    const ops = await (await app.request("/operations")).text();
    for (const a of body.alerts) expect(ops).toContain(a.title);
    expect(ops).not.toContain("All running");

    const status = (await (await app.request("/api/status")).json()) as { problems: number };
    expect(status.problems).toBeGreaterThanOrEqual(2); // the failed escalation + the silent scheduler
  });
});

describe("deployment guards", () => {
  const live = {
    ADMIN_PASSWORD: "x", CRON_SECRET: "x", PUBLIC_URL: "https://x.example", DATABASE_URL: "postgres://x",
    MESSAGING_MODE: "live", TWILIO_ACCOUNT_SID: "AC", TWILIO_AUTH_TOKEN: "t",
    GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "g", GOOGLE_REFRESH_TOKEN: "g",
  };

  it("never lets a preview deployment text real guests", () => {
    expect(() => validateRuntime({ ...live, VERCEL_ENV: "preview", NODE_ENV: "production" })).toThrow(/Preview deployments must not text guests/);
    expect(() => validateRuntime({ VERCEL_ENV: "preview", NODE_ENV: "production", DATABASE_URL: "postgres://staging" })).toThrow(/ADMIN_PASSWORD/);
    expect(() => validateRuntime({ VERCEL_ENV: "preview", NODE_ENV: "production", DATABASE_URL: "postgres://staging", ADMIN_PASSWORD: "x" })).not.toThrow();
  });

  it("holds production to the full live configuration", () => {
    expect(() => validateRuntime({ ...live, VERCEL_ENV: "production" })).not.toThrow();
    expect(() => validateRuntime({ ...live, VERCEL_ENV: "production", MESSAGING_MODE: "console" })).toThrow();
  });

  it("only runs production as a demo when asked to", () => {
    expect(demoMode({ VERCEL: "1", VERCEL_ENV: "preview" })).toBe(true);
    expect(demoMode({ VERCEL: "1", VERCEL_ENV: "production" })).toBe(false);
    expect(demoMode({ VERCEL: "1", VERCEL_ENV: "production", REVIEWLOOP_DEMO: "1" })).toBe(true);
    expect(demoMode({ VERCEL: "1", VERCEL_ENV: "production", DATABASE_URL: "postgres://x" })).toBe(false);
  });
});

describe("helpers", () => {
  it("drops sslmode so a supplied CA certificate takes effect", () => {
    expect(withoutSslMode("postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require&pgbouncer=true"))
      .toBe("postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true");
  });

  it("compares bearer tokens exactly", () => {
    expect(bearerMatches("Bearer abc", "abc")).toBe(true);
    expect(bearerMatches("Bearer abcd", "abc")).toBe(false);
    expect(bearerMatches("abc", "abc")).toBe(false);
    expect(bearerMatches(undefined, "abc")).toBe(false);
  });
});
