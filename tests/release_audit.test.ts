import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { ConsoleMessenger, LiveMessenger, TwilioSms } from "../src/messaging.js";
import { dispatchOutbox } from "../src/outbox.js";
import { twilioSignature } from "../src/inbound/twilioSignature.js";
import { MockReviewSource } from "../src/reviews/sources.js";
import { TemplateDrafter } from "../src/reviews/drafter.js";
import { testDb } from "./helpers.js";
import { assertMigrated, migrate, onlineIndexSql, openPglite, type Db } from "../src/db.js";
import { readFileSync, readdirSync } from "node:fs";

const now = new Date("2026-10-14T19:00:00Z");
const databases: Db[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const db of databases.splice(0)) await db.close(); });

describe("release alert monitoring", () => {
  it("makes an uncertain staff alert fail the independent health check", async () => {
    const db = await testDb(); databases.push(db);
    await db.query("insert into sync_state (key, value, updated_at) values ('scheduler', $1, $2)", [JSON.stringify({ errors: [] }), now.toISOString()]);
    const app = createApp({ db, messenger: new ConsoleMessenger(true), source: new MockReviewSource(), drafter: new TemplateDrafter(), now: () => now });
    expect((await app.request("/healthz")).status).toBe(200);
    await db.query(`insert into outbound_queue (payload, status, locked_at, last_error)
      values ($1, 'cancelled', $2, 'Send outcome unknown')`, [JSON.stringify({ channel: "sms", kind: "alert", to: "+16265559001", body: "URGENT smoke" }), now.toISOString()]);
    const response = await app.request("/healthz");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ alerts: "attention" });
  });

  it("reconciles an accepted Twilio send from its signed status callback after a lost API response", async () => {
    const db = await testDb(); databases.push(db);
    await db.query("insert into sync_state (key, value, updated_at) values ('scheduler', $1, $2)", [JSON.stringify({ errors: [] }), now.toISOString()]);
    const [property] = await db.query("select * from properties where id = 'sunset'");
    await db.query("insert into outbound_queue (payload, next_attempt_at) values ($1, $2)", [
      JSON.stringify({ property, kind: "alert", channel: "sms", to: "+16265559001", body: "URGENT smoke" }), now.toISOString(),
    ]);
    const callback = "https://rl.example/webhooks/twilio/status";
    const sms = new TwilioSms("AC1", "token", "", callback);
    const messenger = new LiveMessenger(sms, null);
    let sentCallback = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sentCallback = new URLSearchParams(String(init.body)).get("StatusCallback") ?? "";
      throw new Error("connection reset after acceptance");
    }));
    await dispatchOutbox(db, messenger, now);
    expect((await db.query<{ status: string }>("select status from outbound_queue"))[0]?.status).toBe("cancelled");
    expect(sentCallback).toContain("rl_outbox=1");
    const fields = { MessageSid: "SMaccepted", MessageStatus: "delivered" };
    const signed = twilioSignature("token", sentCallback, fields);
    const app = createApp({ db, messenger, source: new MockReviewSource(), drafter: new TemplateDrafter(), now: () => now, publicUrl: "https://rl.example", twilioAuthToken: "token" });
    const path = new URL(sentCallback).pathname + new URL(sentCallback).search;
    const deliver = () => app.request(path, { method: "POST", body: new URLSearchParams(fields), headers: { "X-Twilio-Signature": signed } });
    expect((await deliver()).status).toBe(204);
    expect((await deliver()).status).toBe(204); // Twilio retries its callback too.
    expect((await db.query<{ status: string }>("select status from outbound_queue"))[0]?.status).toBe("sent");
    expect((await db.query("select provider_id from messages where provider_id = 'SMaccepted'"))).toHaveLength(1);
    expect((await app.request("/healthz")).status).toBe(200);
  });
});

describe("live migration preflight", () => {
  it("rejects serving an unmigrated database and accepts it after explicit migration", async () => {
    const db = await openPglite(); databases.push(db);
    await expect(assertMigrated(db)).rejects.toThrow("Database migrations pending");
    await migrate(db);
    await expect(assertMigrated(db)).resolves.toBeUndefined();
  });

  it("builds all existing inbox indexes concurrently in the live migration plan", () => {
    const sql = readFileSync(new URL("../db/migrations/005_inbox_indexes.sql", import.meta.url), "utf8");
    const statements = onlineIndexSql(sql);
    expect(statements).toHaveLength(8);
    expect(statements.every((s) => /^CREATE INDEX CONCURRENTLY IF NOT EXISTS /i.test(s))).toBe(true);
    const outbound = readFileSync(new URL("../db/migrations/007_send_failures.sql", import.meta.url), "utf8");
    expect(outbound).toMatch(/check \(status in [^;]+\) not valid;/i);
    expect(onlineIndexSql(outbound.split(";").find((s) => /^create\s+index/i.test(s.trim())) ?? "")).toHaveLength(1);
  });

  it("executes existing-table indexes outside the live migration transaction", async () => {
    const files = readdirSync(new URL("../db/migrations/", import.meta.url)).filter((f) => f.endsWith(".sql"));
    for (const target of ["005_inbox_indexes.sql", "007_send_failures.sql"]) {
      const calls: string[] = [];
      const client = {
        query: async (sql: string) => {
          calls.push(sql);
          if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ ok: true }] };
          return { rows: sql === "select name from schema_migrations" ? files.filter((f) => f !== target).map((name) => ({ name })) : [] };
        },
        release: () => {},
      };
      const fake = { pool: { connect: async () => client } } as unknown as Db;
      expect(await migrate(fake)).toEqual([target]);
      const builds = calls.filter((s) => /^CREATE INDEX CONCURRENTLY/i.test(s));
      expect(builds.length).toBe(target.startsWith("005") ? 8 : 1);
      const firstBuild = calls.findIndex((s) => /^CREATE INDEX CONCURRENTLY/i.test(s));
      if (target.startsWith("007")) expect(calls.slice(0, firstBuild)).toContain("COMMIT");
      expect(calls.slice(firstBuild).some((s) => s === "BEGIN")).toBe(false);
    }
  });
});
