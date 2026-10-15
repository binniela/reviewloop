import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createApp, ingest, tick, TICK_LEASE_SECONDS, type AppDeps } from "../src/app.js";
import { openPostgres, pgPoolConfig, type Db } from "../src/db.js";
import { KeywordClassifier } from "../src/inbound/classify.js";
import { handleInbound } from "../src/inbound/handle.js";
import { twilioSignature } from "../src/inbound/twilioSignature.js";
import { ConsoleMessenger, LiveMessenger, messengerFromEnv, ProviderRejectedError, TwilioSms, type Messenger } from "../src/messaging.js";
import { resolveCase, runCaseTimers } from "../src/inbound/cases.js";
import { runDueJobs } from "../src/milestones/engine.js";
import { dispatchOutbox } from "../src/outbox.js";
import { TemplateDrafter, type ReplyDrafter } from "../src/reviews/drafter.js";
import { MockReviewSource } from "../src/reviews/sources.js";
import { testDb } from "./helpers.js";

/** Regression tests for problems found while preparing the live staging launch. */

const databases: Db[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const db of databases.splice(0)) await db.close();
});

const START = new Date("2026-10-14T18:00:00Z"); // 11 AM in Los Angeles, outside quiet hours
const later = (minutes: number) => new Date(START.getTime() + minutes * 60_000);
const GUEST = "+16265550101";
const HOTEL = "+16265550000";
const csv = 'Confirmation,Guest Name,Phone,SMS Opt In,Room,Arrival,Departure,Status\n1,"PATEL, ANITA",6265550101,Y,104,10/13/2026,10/16/2026,In House';

async function fixture(extra: Partial<AppDeps> = {}) {
  const db = await testDb();
  databases.push(db);
  const messenger = new ConsoleMessenger(true);
  let clock = START;
  const deps: AppDeps = {
    db, messenger, classifier: new KeywordClassifier(), source: new MockReviewSource({ sunset: [] }), drafter: new TemplateDrafter(),
    now: () => clock, cronSecret: "s", twilioAuthToken: "tok", publicUrl: "https://rl.example", ...extra,
  };
  await ingest(deps, "sunset", "in_house", csv);
  return { db, messenger, deps, set: (d: Date) => (clock = d) };
}

/** Twilio's Messages API as seen by fetch: a queue of canned responses, plus the requests made. */
function fakeTwilio(responses: { status: number; body: Record<string, unknown> }[]) {
  const calls: URLSearchParams[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    calls.push(new URLSearchParams(String(init.body)));
    const r = responses.shift() ?? { status: 201, body: { sid: `SM${calls.length}` } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}
const live = () => new LiveMessenger(new TwilioSms("AC1", "tok", "", "https://rl.example/webhooks/twilio/status"), null);

describe("HELP keyword", () => {
  it("does not page the GM or send a second reply when a guest texts HELP", async () => {
    const f = await fixture();
    await handleInbound(f.db, { messenger: f.messenger, classifier: new KeywordClassifier(), now: () => START }, { from: GUEST, to: HOTEL, body: "HELP", providerId: "SMhelp" });
    // Twilio answers HELP itself (Advanced Opt-Out). The desk still sees it, at normal urgency.
    expect(f.messenger.sent.filter((m) => m.to === GUEST)).toHaveLength(0);
    expect(f.messenger.sent.filter((m) => m.to === "+16265559002")).toHaveLength(0);
    const [c] = await f.db.query<{ urgency: string; kind: string }>("select urgency, kind from recovery_cases");
    expect(c).toMatchObject({ urgency: "normal", kind: "request" });
    expect(f.messenger.sent.filter((m) => m.to === "+16265559001")).toHaveLength(1);
  });

  it("still treats a sentence asking for help as a real request", async () => {
    const f = await fixture();
    await handleInbound(f.db, { messenger: f.messenger, classifier: new KeywordClassifier(), now: () => START }, { from: GUEST, to: HOTEL, body: "Help, there's smoke in the hallway", providerId: "SMsmoke" });
    const [c] = await f.db.query<{ urgency: string }>("select urgency from recovery_cases");
    expect(c!.urgency).toBe("urgent");
    expect(f.messenger.sent.filter((m) => m.to === "+16265559002")).toHaveLength(1);
  });
});

describe("webhook signatures behind Vercel deployment protection", () => {
  it("verifies a webhook URL that carries a query string, and still refuses unsigned or tampered requests", async () => {
    const f = await fixture();
    const app = createApp(f.deps);
    const path = "/webhooks/twilio/sms?x-vercel-protection-bypass=abc123";
    const params = { From: GUEST, To: HOTEL, Body: "Towels please", MessageSid: "SMq" };
    const sig = twilioSignature("tok", `https://rl.example${path}`, params);
    const post = (p: string, headers: Record<string, string>) => app.request(p, { method: "POST", body: new URLSearchParams(params), headers });
    expect((await post(path, {})).status).toBe(403);
    expect((await post(path.replace("abc123", "other"), { "X-Twilio-Signature": sig })).status).toBe(403);
    expect((await post(path, { "X-Twilio-Signature": sig })).status).toBe(200);

    const status = { MessageSid: "SMx", MessageStatus: "undelivered", ErrorCode: "30003" };
    const statusPath = "/webhooks/twilio/status?x-vercel-protection-bypass=abc123";
    const statusSig = twilioSignature("tok", `https://rl.example${statusPath}`, status);
    const res = await app.request(statusPath, { method: "POST", body: new URLSearchParams(status), headers: { "X-Twilio-Signature": statusSig } });
    expect(res.status).toBe(204);
  });

  it("passes the bypass token through to the delivery callback Twilio is given", async () => {
    const calls = fakeTwilio([]);
    const sms = new TwilioSms("AC1", "tok", "", "https://rl.example/webhooks/twilio/status?x-vercel-protection-bypass=abc123");
    await sms.send(GUEST, "hi", HOTEL);
    expect(calls[0]!.get("StatusCallback")).toBe("https://rl.example/webhooks/twilio/status?x-vercel-protection-bypass=abc123");
  });
});

describe("delivery callbacks behind Vercel deployment protection", () => {
  it("adds Vercel's automation bypass token to the StatusCallback when protection is on", async () => {
    const calls = fakeTwilio([]);
    const m = messengerFromEnv({ MESSAGING_MODE: "live", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok", PUBLIC_URL: "https://rl.example/", VERCEL_AUTOMATION_BYPASS_SECRET: "byp" });
    await m.send({ channel: "sms", to: GUEST, body: "hi", from: HOTEL });
    expect(calls[0]!.get("StatusCallback")).toBe("https://rl.example/webhooks/twilio/status?x-vercel-protection-bypass=byp");
  });
});

describe("failed sends", () => {
  it("stops retrying a follow-up the provider rejected for good", async () => {
    const f = await fixture();
    await handleInbound(f.db, { messenger: f.messenger, classifier: new KeywordClassifier(), now: () => START }, { from: GUEST, to: HOTEL, body: "AC is broken", providerId: "SMfu" });
    const [c] = await f.db.query<{ id: string }>("select id::text from recovery_cases");
    await resolveCase(f.db, c!.id, "Fixed", "maria", START);
    let sends = 0;
    const rejecting: Messenger = { send: async () => { sends++; throw new ProviderRejectedError("Twilio 400 (code 21614): not a mobile number", 21614); } };
    await runCaseTimers(f.db, rejecting, later(31));
    await runCaseTimers(f.db, rejecting, later(60));
    expect(sends).toBe(1);
    const [row] = await f.db.query<{ followup_error: string }>("select followup_error from recovery_cases");
    expect(row!.followup_error).toContain("21614");
  });

  it("does not retry a number Twilio rejects permanently, and shows it on Operations", async () => {
    const calls = fakeTwilio([{ status: 400, body: { code: 21211, message: "Invalid 'To' Phone Number" } }]);
    const f = await fixture({ messenger: live() });
    await handleInbound(f.db, { messenger: live(), classifier: new KeywordClassifier(), now: () => START }, { from: GUEST, to: HOTEL, body: "AC is broken", providerId: "SMac" });
    // Desk alert hit the permanent error; the guest acknowledgement went through.
    const failed = await f.db.query<{ status: string; last_error: string }>("select status, last_error from outbound_queue where status = 'failed'");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.last_error).toContain("21211");
    const before = calls.length;
    await dispatchOutbox(f.db, live(), later(120));
    expect(calls.length).toBe(before);
    const ops = await (await createApp(f.deps).request("/operations")).text();
    expect(ops).toContain("21211");
  });

  it("records a Twilio-side unsubscribe (21610) as an opt-out", async () => {
    fakeTwilio([{ status: 400, body: { code: 21610, message: "Attempt to send to unsubscribed recipient" } }]);
    const f = await fixture({ messenger: live() });
    f.set(later(0));
    const summary = await runDueJobs(f.db, { messenger: live(), now: () => START });
    expect(summary.failed).toBe(1);
    expect(await f.db.query("select phone from opt_outs")).toEqual([{ phone: GUEST }]);
  });

  it("retries a temporary Twilio failure with backoff until it goes through", async () => {
    const calls = fakeTwilio([{ status: 503, body: { message: "Service unavailable" } }]);
    const f = await fixture();
    await handleInbound(f.db, { messenger: new ConsoleMessenger(true), classifier: new KeywordClassifier(), now: () => START }, { from: GUEST, to: HOTEL, body: "hi", providerId: "SMhi" }).catch(() => {});
    await f.db.query("delete from outbound_queue");
    await f.db.query(`insert into outbound_queue (payload, next_attempt_at) values ($1, $2)`, [
      JSON.stringify({ property: { id: "sunset", name: "Sunset Inn", sms_from: HOTEL }, kind: "alert", channel: "sms", to: "+16265559001", body: "test" }), START.toISOString(),
    ]);
    expect((await dispatchOutbox(f.db, live(), START)).errors).toHaveLength(1);
    const [row] = await f.db.query<{ status: string; next_attempt_at: Date }>("select status, next_attempt_at from outbound_queue");
    expect(row!.status).toBe("pending");
    expect(new Date(row!.next_attempt_at) > START).toBe(true);
    expect((await dispatchOutbox(f.db, live(), later(5))).sent).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it("gives up after a bounded number of temporary failures instead of retrying forever", async () => {
    const outage: Messenger = { send: async () => { throw new Error("Twilio 503: down"); } };
    const f = await fixture();
    await f.db.query(`insert into outbound_queue (payload, next_attempt_at) values ($1, $2)`, [
      JSON.stringify({ property: { id: "sunset", name: "Sunset Inn", sms_from: HOTEL }, kind: "alert", channel: "sms", to: "+16265559001", body: "test" }), START.toISOString(),
    ]);
    for (let i = 0; i < 20; i++) await dispatchOutbox(f.db, outage, later(i * 24 * 60));
    const [row] = await f.db.query<{ status: string; attempts: number }>("select status, attempts from outbound_queue");
    expect(row!.status).toBe("failed");
    expect(row!.attempts).toBeLessThanOrEqual(10);
  });
});

describe("scheduler health", () => {
  it("shows a scheduled-job error on Operations and keeps running the other steps", async () => {
    const source = new MockReviewSource({ sunset: [] });
    source.fetchReviews = async () => { throw new Error("Google 403: PERMISSION_DENIED"); };
    const f = await fixture({ source });
    await f.db.query("update jobs set status = 'pending', run_at = $1", [START.toISOString()]);
    const broken = { ...f.deps, drafter: f.deps.drafter };
    // Break one step outright: the events table is unreadable for this tick.
    await f.db.query("alter table events rename to events_gone");
    const result = await tick(broken);
    await f.db.query("alter table events_gone rename to events");
    expect(result.ok).toBe(false);
    expect(f.messenger.sent.some((m) => m.to === GUEST)).toBe(true); // jobs still ran
    const ops = await (await createApp(f.deps).request("/operations")).text();
    expect(ops).toContain("Scheduler");
    expect(ops).toContain("events");
    const status = (await (await createApp(f.deps).request("/api/status")).json()) as { problems: number };
    expect(status.problems).toBeGreaterThan(0);
  });

  it("returns 500 from /cron/tick when a step fails, so Vercel marks the cron run failed", async () => {
    const f = await fixture();
    await f.db.query("alter table events rename to events_gone");
    const res = await createApp(f.deps).request("/cron/tick", { headers: { Authorization: "Bearer s" } });
    await f.db.query("alter table events_gone rename to events");
    expect(res.status).toBe(500);
  });

  it("flags a scheduler that stopped running, on Operations and on /healthz", async () => {
    const f = await fixture();
    await tick(f.deps);
    const app = createApp(f.deps);
    expect((await app.request("/healthz")).status).toBe(200);
    f.set(later(30));
    const ops = await (await app.request("/operations")).text();
    expect(ops).toContain("hasn’t run");
    const health = await app.request("/healthz");
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ db: "ok", scheduler: "stale" });
  });

  it("lets only one of two overlapping ticks do the work", async () => {
    let drafts = 0;
    const slow: ReplyDrafter = { draft: async () => { drafts++; await new Promise((r) => setTimeout(r, 50)); return "Thanks!"; } };
    const source = new MockReviewSource({ sunset: [{ externalId: "r/1", author: "Eli K", rating: 5, body: "Great", reviewedAt: "2026-10-14T15:00:00Z", existingReply: null }] });
    const f = await fixture({ source, drafter: slow });
    const [a, b] = await Promise.all([tick(f.deps), tick(f.deps)]);
    expect([a.skipped, b.skipped].filter(Boolean)).toHaveLength(1);
    expect(drafts).toBe(1);
    const sync = await f.db.query<{ value: string }>("select value from sync_state where key = 'reviews:sunset'");
    expect(JSON.parse(sync[0]!.value).ok).toBe(true);
  });

  it("holds the tick lease longer than Vercel lets the function run, and leaves the tick 20 s of slack", () => {
    const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as { functions: Record<string, { maxDuration: number }> };
    const max = vercel.functions["api/index.ts"]!.maxDuration;
    expect(TICK_LEASE_SECONDS).toBeGreaterThan(max);
    expect(40).toBeLessThanOrEqual(max - 20); // default tickBudgetMs is 40 s
  });

  it("runs a late tick once and catches up on escalations it missed", async () => {
    const f = await fixture();
    await handleInbound(f.db, { messenger: f.messenger, classifier: new KeywordClassifier(), now: () => START }, { from: GUEST, to: HOTEL, body: "AC is broken", providerId: "SMlate" });
    f.set(later(95)); // cron was down for over an hour
    await tick(f.deps);
    await tick(f.deps);
    expect(f.messenger.sent.filter((m) => m.to === "+16265559002")).toHaveLength(1);
  });

  it("stops drafting when the tick's time budget runs out and picks up the rest next tick", async () => {
    const reviews = Array.from({ length: 4 }, (_, i) => ({ externalId: `r/${i}`, author: "Eli K", rating: 5, body: "Great", reviewedAt: "2026-10-14T15:00:00Z", existingReply: null }));
    const slow: ReplyDrafter = { draft: async () => { await new Promise((r) => setTimeout(r, 30)); return "Thanks!"; } };
    const f = await fixture({ source: new MockReviewSource({ sunset: reviews }), drafter: slow, tickBudgetMs: 40 });
    await tick(f.deps);
    const first = await f.db.query("select id from reply_drafts");
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(4);
    for (let i = 0; i < 4; i++) await tick(f.deps);
    expect(await f.db.query("select id from reply_drafts")).toHaveLength(4);
  });
});

describe("Postgres connection", () => {
  it("verifies the Supabase certificate instead of accepting any remote server", () => {
    const cfg = pgPoolConfig("postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require", {});
    expect(cfg.connectionString).not.toContain("sslmode");
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
  });

  it("verifies the server when the Supabase CA certificate is provided", () => {
    const ca = "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----";
    const cfg = pgPoolConfig("postgresql://u:p@db.example.supabase.co:5432/postgres", { DATABASE_CA_CERT: ca });
    expect(cfg.ssl).toEqual({ ca, rejectUnauthorized: true });
  });

  it("survives the pooler dropping an idle connection instead of crashing the process", async () => {
    const db = await openPostgres("postgresql://u:p@localhost:1/rl");
    expect(db.pool.listenerCount("error")).toBeGreaterThan(0);
    expect(() => db.pool.emit("error", new Error("Connection terminated unexpectedly"))).not.toThrow();
    await db.close();
  });

  it("leaves a local database unencrypted", () => {
    expect(pgPoolConfig("postgresql://u:p@localhost:5432/rl", {}).ssl).toBe(false);
    expect(() => pgPoolConfig("postgresql://u:p@db.internal:5432/rl?sslmode=disable", {})).toThrow("verified TLS");
  });
});

describe("text provider credentials", () => {
  const unauthorized = { status: 401, body: { code: 20003, message: "Authenticate" } };

  it("keeps retrying a queued text when Twilio rejects our credentials, and raises a critical alert", async () => {
    fakeTwilio(Array.from({ length: 30 }, () => unauthorized));
    const f = await fixture();
    await f.db.query("delete from outbound_queue");
    await f.db.query(`insert into outbound_queue (payload, next_attempt_at) values ($1, $2)`, [
      JSON.stringify({ property: { id: "sunset", name: "Sunset Inn", sms_from: HOTEL }, kind: "alert", channel: "sms", to: "+16265559001", body: "test" }), START.toISOString(),
    ]);
    for (let i = 0; i < 20; i++) await dispatchOutbox(f.db, live(), later(i * 60));
    const [row] = await f.db.query<{ status: string; last_error: string }>("select status, last_error from outbound_queue");
    expect(row!.status).toBe("pending"); // a fixed token sends it; nothing is given up on
    expect(row!.last_error).toMatch(/credentials/);
    const { alertStatus } = await import("../src/alerts.js");
    const { alerts, ok } = await alertStatus(f.db, later(20 * 60), { scheduler: false });
    expect(ok).toBe(false);
    expect(alerts.find((a) => a.code === "provider_credentials")).toMatchObject({ severity: "critical" });
  });

  it("keeps a scheduled text pending instead of failing it", async () => {
    fakeTwilio(Array.from({ length: 30 }, () => unauthorized));
    const f = await fixture();
    for (let i = 0; i < 10; i++) await runDueJobs(f.db, { messenger: live(), now: () => later(i * 20) });
    const [job] = await f.db.query<{ status: string; result: string }>("select status, result from jobs where kind = 'mid_stay'");
    expect(job).toMatchObject({ status: "pending" });
    expect(job!.result).toMatch(/credentials/);
  });
});
