import { afterEach, describe, expect, it } from "vitest";
import { createApp, ingest, tick, type AppDeps } from "../src/app.js";
import { approveConsent, recordConsent } from "../src/consent.js";
import type { Db } from "../src/db.js";
import { KeywordClassifier } from "../src/inbound/classify.js";
import { handleInbound } from "../src/inbound/handle.js";
import { acknowledgeCase, replyToGuest, runCaseTimers } from "../src/inbound/cases.js";
import { ConsoleMessenger, type Messenger } from "../src/messaging.js";
import { dispatchOutbox } from "../src/outbox.js";
import { TemplateDrafter } from "../src/reviews/drafter.js";
import { MockReviewSource } from "../src/reviews/sources.js";
import { syncReviews } from "../src/reviews/sync.js";
import { validateRuntime } from "../src/runtime.js";
import { testDb } from "./helpers.js";

const databases: Db[] = [];
afterEach(async () => { for (const db of databases.splice(0)) await db.close(); });
const START = new Date("2026-10-14T18:00:00Z");
const later = (minutes: number) => new Date(START.getTime() + minutes * 60000);
const csv = 'Confirmation,Guest Name,Phone,SMS Opt In,Room,Arrival,Departure,Status\n1,"PATEL, ANITA",6265550101,Y,104,10/13/2026,10/16/2026,In House';
const sms = (body: string, id = "SM1", from = "+16265550101") => ({ body, providerId: id, from, to: "+16265550000" });
async function fixture() {
  const db = await testDb(); databases.push(db);
  const messenger = new ConsoleMessenger(true);
  const classifier = new KeywordClassifier();
  const deps: AppDeps = { db, messenger, classifier, source: new MockReviewSource(), drafter: new TemplateDrafter(), now: () => START };
  await ingest(deps, "sunset", "in_house", csv);
  return { db, messenger, classifier, deps };
}
const outage: Messenger = { send: async () => { throw new Error("provider unavailable"); } };

describe("durable guest processing", () => {
  it("keeps the first staff claimant when two people acknowledge together", async () => {
    const f = await fixture();
    await handleInbound(f.db, { messenger: f.messenger, classifier: f.classifier, now: () => START }, sms("AC broken"));
    const [c] = await f.db.query<{ id: string }>("select id::text from recovery_cases");
    await Promise.all([acknowledgeCase(f.db, c!.id, "A", later(1)), acknowledgeCase(f.db, c!.id, "B", later(1))]);
    const [row] = await f.db.query<{ acknowledged_by: string; acknowledged_at: Date }>("select acknowledged_by, acknowledged_at from recovery_cases where id = $1", [c!.id]);
    expect(["A", "B"]).toContain(row!.acknowledged_by);
    expect(new Date(row!.acknowledged_at).toISOString()).toBe(later(1).toISOString());
  });

  it("claims queued messages once across overlapping dispatch calls", async () => {
    const f = await fixture();
    await f.db.query("insert into outbound_queue (payload, next_attempt_at) values ($1, $2)", [JSON.stringify({
      property: { id: "sunset", name: "Sunset", sms_from: "+16265550000" }, kind: "alert", channel: "sms", to: "+16265559001", body: "Help",
    }), START.toISOString()]);
    await Promise.all([dispatchOutbox(f.db, f.messenger, START), dispatchOutbox(f.db, f.messenger, START)]);
    expect(f.messenger.sent.filter(m => m.body === "Help")).toHaveLength(1);
    expect(await f.db.query("select id from outbound_queue where status = 'sent'")).toHaveLength(1);
  });

  it("re-imports the same report without another stay or event", async () => {
    const f = await fixture();
    await Promise.all([ingest(f.deps, "sunset", "in_house", csv), ingest(f.deps, "sunset", "in_house", csv)]);
    expect(await f.db.query("select id from stays where confirmation = '1'")).toHaveLength(1);
    expect(await f.db.query("select id from events where idempotency_key like 'sunset:1:%'")).toHaveLength(2);
  });
  it("retries failed alerts independently of duplicate webhooks, without duplicate cases or successful recipients", async () => {
    const f = await fixture();
    const partial: Messenger = { send: async (m) => m.to.includes("desk@") ? outage.send(m) : f.messenger.send(m) };
    await handleInbound(f.db, { messenger: partial, classifier: f.classifier, now: () => START }, sms("Can we get extra towels?"));
    expect(await f.db.query("select kind from recovery_cases")).toEqual([{ kind: "request" }]);
    expect(f.messenger.sent.filter(m => m.to === "+16265559001")).toHaveLength(1);
    expect(await handleInbound(f.db, { messenger: f.messenger, classifier: f.classifier, now: () => later(3) }, sms("Can we get extra towels?"))).toEqual({ action: "duplicate" });
    expect(f.messenger.sent.filter(m => m.to === "+16265559001")).toHaveLength(1);
    expect(f.messenger.sent.filter(m => m.to === "desk@sunset.example")).toHaveLength(1);
    expect(await f.db.query("select id from outbound_queue where status <> 'sent'")).toHaveLength(0);
  });

  it("serializes duplicate deliveries and preserves one set of outgoing effects", async () => {
    const f = await fixture();
    const deps = { messenger: f.messenger, classifier: f.classifier, now: () => START };
    const results = await Promise.all([handleInbound(f.db, deps, sms("AC broken")), handleInbound(f.db, deps, sms("AC broken"))]);
    expect(results.filter(r => r.action === "duplicate")).toHaveLength(1);
    expect(await f.db.query("select id from recovery_cases")).toHaveLength(1);
    expect(f.messenger.sent).toHaveLength(3);
  });

  it("retains ambiguous messages as actionable requests and does not penalize satisfaction", async () => {
    const f = await fixture();
    await handleInbound(f.db, { messenger: f.messenger, classifier: f.classifier, now: () => START }, sms("Something about my reservation"));
    expect(await f.db.query("select kind from recovery_cases")).toEqual([{ kind: "request" }]);
    expect(await f.db.query("select satisfaction from stays")).toEqual([{ satisfaction: 0 }]);
    const [c] = await f.db.query<{ id: string }>("select id::text from recovery_cases");
    await replyToGuest(f.db, f.messenger, c!.id, "How can we help?", "staff", START);
    expect(f.messenger.sent.at(-1)?.to).toBe("+16265550101");
  });

  it("does not route an unknown hotel number to the only configured hotel", async () => {
    const f = await fixture();
    expect(await handleInbound(f.db, { messenger: f.messenger, classifier: f.classifier }, { ...sms("AC broken"), to: "+16265559999" })).toEqual({ action: "unknown_property" });
    expect(f.messenger.sent).toHaveLength(0);
  });

  it("checks STOP again before delivering queued guest messages", async () => {
    const f = await fixture();
    await handleInbound(f.db, { messenger: outage, classifier: f.classifier, now: () => START }, sms("AC broken"));
    await handleInbound(f.db, { messenger: f.messenger, classifier: f.classifier, now: () => later(1) }, sms("STOP", "SMstop"));
    await dispatchOutbox(f.db, f.messenger, later(3));
    expect(f.messenger.sent.filter(m => m.to === "+16265550101")).toHaveLength(0);
    await handleInbound(f.db, { messenger: f.messenger, classifier: f.classifier, now: () => later(4) }, sms("yes", "SMyes"));
    expect(await f.db.query("select phone from opt_outs")).toHaveLength(1);
  });

  it("does not mark failed or unconfigured escalation as successful, then retries", async () => {
    const f = await fixture();
    await handleInbound(f.db, { messenger: f.messenger, classifier: f.classifier, now: () => START }, sms("AC broken"));
    expect((await runCaseTimers(f.db, outage, later(21))).escalated).toBe(0);
    const [failed] = await f.db.query<{ escalated_at: Date | null; escalation_error: string }>("select escalated_at, escalation_error from recovery_cases");
    expect(failed!.escalated_at).toBeNull();
    expect(failed!.escalation_error).toContain("provider unavailable");
    expect((await runCaseTimers(f.db, f.messenger, later(22))).escalated).toBe(0);
    expect((await runCaseTimers(f.db, f.messenger, later(26))).escalated).toBe(1);
    expect((await runCaseTimers(f.db, f.messenger, later(30))).escalated).toBe(0);
  });
});

describe("consent and production safety", () => {
  it("does not replace contact from a public form or a later report; requires staff verification", async () => {
    const f = await fixture();
    const input = { propertyId: "sunset", lastName: "Patel", room: "104", phone: "6265550199", agreed: true };
    const pending = await recordConsent(f.db, f.messenger, input, START);
    expect(pending.status).toBe("pending");
    if (pending.status !== "pending") throw new Error("expected pending");
    await ingest(f.deps, "sunset", "in_house", csv);
    expect(await f.db.query("select consent_phone from stays")).toEqual([{ consent_phone: null }]);
    const app = createApp({ ...f.deps, adminPassword: "pw" });
    expect((await app.request(`/api/consents/${pending.consentId}/approve`, { method: "POST" })).status).toBe(401);
    expect(await approveConsent(f.db, f.messenger, pending.consentId, "verified-in-person", START)).toMatchObject({ status: "linked" });
    expect(await f.db.query("select consent_phone from stays")).toEqual([{ consent_phone: "+16265550199" }]);
  });

  it("never clears an opt-out on web signup or staff approval", async () => {
    const f = await fixture();
    await f.db.query("insert into opt_outs (phone) values ('+16265550199')");
    const result = await recordConsent(f.db, f.messenger, { propertyId: "sunset", lastName: "Patel", room: "104", phone: "6265550199", agreed: true }, START);
    if (result.status !== "pending") throw new Error("expected pending");
    expect((await approveConsent(f.db, f.messenger, result.consentId, "staff", START)).status).toBe("invalid");
    expect(await f.db.query("select phone from opt_outs")).toHaveLength(1);
  });

  it("fails closed in production and keeps local development available", async () => {
    const f = await fixture();
    expect(() => createApp({ ...f.deps, production: true })).toThrow(/ADMIN_PASSWORD/);
    expect(() => validateRuntime({ NODE_ENV: "production" })).toThrow(/ADMIN_PASSWORD/);
    expect(() => validateRuntime({})).not.toThrow();
  });
});

describe("routing, reviews and operational data", () => {
  it("handles the classifier counterexamples from the audit", async () => {
    const k = new KeywordClassifier();
    expect(await k.classify("The room is freezing")).toMatchObject({ sentiment: "negative", category: "maintenance" });
    expect(await k.classify("What is the wifi password?")).toMatchObject({ sentiment: "neutral", category: "question" });
    expect(await k.classify("No complaints, thanks")).toMatchObject({ sentiment: "positive", category: "praise" });
  });

  it("defaults new properties to approval and avoids a happy-stay template for mixed feedback", async () => {
    const f = await fixture();
    const source = new MockReviewSource({ sunset: [{ externalId: "review1", author: "Anita P", rating: 4, body: "AC was loud but staff moved us", reviewedAt: START.toISOString(), existingReply: null }] });
    const result = await syncReviews(f.db, "sunset", { source, drafter: new TemplateDrafter(), now: () => START });
    expect(result).toMatchObject({ autoPosted: 0, awaitingApproval: 1 });
    const [draft] = await f.db.query<{ draft: string }>("select draft from reply_drafts");
    expect(draft!.draft).not.toContain("glad you enjoyed");
  });

  it("exposes backend diagnostics and denominators without pretending accepted messages are delivered", async () => {
    const f = await fixture();
    await tick(f.deps);
    const app = createApp(f.deps);
    const metrics = await app.request("/api/metrics/sunset?since=2026-10-01T00:00:00Z");
    expect(metrics.status).toBe(200);
    expect(await metrics.json()).toMatchObject({ stays: 1, textable_stays: 1, unresolved: 0 });
    const ops = await (await app.request("/api/operations")).json() as { sync: { key: string }[] };
    expect(ops.sync.some(s => s.key === "import:sunset:in_house")).toBe(true);
    expect(ops.sync.some(s => s.key === "reviews:sunset")).toBe(true);
  });
});

describe("delivery integrity and reporting", () => {
  it("quarantines an uncertain send instead of automatically duplicating it", async () => {
    const { DeliveryUncertainError } = await import("../src/messaging.js");
    const f = await fixture();
    const uncertain: Messenger = { send: async () => { throw new DeliveryUncertainError("timeout after request submission"); } };
    await handleInbound(f.db, { messenger: uncertain, classifier: f.classifier, now: () => START }, sms("AC broken"));
    await dispatchOutbox(f.db, f.messenger, later(30));
    expect(f.messenger.sent).toHaveLength(0);
    expect(await f.db.query("select id from outbound_queue where status = 'cancelled' and last_error like '%timeout%'")).toHaveLength(3);
  });

  it("verifies delivery signatures and handles duplicate and out-of-order receipts", async () => {
    const { twilioSignature } = await import("../src/inbound/twilioSignature.js");
    const f = await fixture();
    const app = createApp({ ...f.deps, twilioAuthToken: "secret", publicUrl: "https://hotel.example" });
    const post = async (status: string, signed = true) => {
      const params = { MessageSid: "SMdelivery", MessageStatus: status };
      return app.request("/webhooks/twilio/status", { method: "POST", body: new URLSearchParams(params), headers: {
        "X-Twilio-Signature": signed ? twilioSignature("secret", "https://hotel.example/webhooks/twilio/status", params) : "bad",
      } });
    };
    expect((await post("delivered", false)).status).toBe(403);
    expect((await post("delivered")).status).toBe(204);
    await post("sent"); await post("delivered");
    expect(await f.db.query("select status from sms_delivery_receipts")).toEqual([{ status: "delivered" }]);
  });

  it("counts in-stay complaints separately from requests and excludes unrelated later replies", async () => {
    const { weeklyMetrics } = await import("../src/web/metrics.js");
    const f = await fixture();
    await handleInbound(f.db, { messenger: f.messenger, classifier: f.classifier, now: () => START }, sms("Can I get towels?"));
    let [week] = await weeklyMetrics(f.db, "sunset", START, 1);
    expect(week!.issues).toBe(0);
    await handleInbound(f.db, { messenger: f.messenger, classifier: f.classifier, now: () => later(1) }, sms("The room is freezing", "SMcold"));
    [week] = await weeklyMetrics(f.db, "sunset", later(1), 1);
    expect(week!.issues).toBe(1);
    await f.db.query("update recovery_cases set opened_at = '2026-10-17T18:00:00Z'");
    [week] = await weeklyMetrics(f.db, "sunset", later(1), 1);
    expect(week!.issues).toBe(0);
  });

  it("records guest confirmation after a follow-up, not merely a staff resolution", async () => {
    const { resolveCase } = await import("../src/inbound/cases.js");
    const f = await fixture();
    await handleInbound(f.db, { messenger: f.messenger, classifier: f.classifier, now: () => START }, sms("AC broken"));
    const [c] = await f.db.query<{ id: string }>("select id::text from recovery_cases");
    await resolveCase(f.db, c!.id, "Repaired AC", "staff", START);
    expect(await f.db.query("select guest_confirmed_at from recovery_cases")).toEqual([{ guest_confirmed_at: null }]);
    await runCaseTimers(f.db, f.messenger, later(31));
    await handleInbound(f.db, { messenger: f.messenger, classifier: f.classifier, now: () => later(32) }, sms("All good now, thanks", "SMfixed"));
    const [confirmed] = await f.db.query<{ guest_confirmed_at: Date }>("select guest_confirmed_at from recovery_cases");
    expect(new Date(confirmed!.guest_confirmed_at).toISOString()).toBe(later(32).toISOString());
  });

  it("does not suppress escalation when every recipient is missing", async () => {
    const f = await fixture();
    await handleInbound(f.db, { messenger: f.messenger, classifier: f.classifier, now: () => START }, sms("AC broken"));
    await f.db.query("update properties set gm_phone = null, desk_phones = '{}', desk_emails = '{}'");
    const result = await runCaseTimers(f.db, f.messenger, later(21));
    expect(result.errors[0]).toContain("No staff alert recipients");
    expect(await f.db.query("select escalated_at from recovery_cases")).toEqual([{ escalated_at: null }]);
  });
});

describe("overlapping workers and historical access", () => {
  it("sends a follow-up once when two timer workers overlap", async () => {
    const { resolveCase } = await import("../src/inbound/cases.js");
    const f = await fixture();
    await handleInbound(f.db, { messenger: f.messenger, classifier: f.classifier, now: () => START }, sms("AC broken"));
    const [c] = await f.db.query<{ id: string }>("select id::text from recovery_cases");
    await resolveCase(f.db, c!.id, "Fixed", "staff", START);
    const results = await Promise.all([runCaseTimers(f.db, f.messenger, later(31)), runCaseTimers(f.db, f.messenger, later(31))]);
    expect(results.reduce((n, r) => n + r.followupsSent, 0)).toBe(1);
    expect(f.messenger.sent.filter(m => m.body.includes("is everything better"))).toHaveLength(1);
  });

  it("keeps old unmatched texts and closed cases accessible through protected APIs", async () => {
    const { resolveCase } = await import("../src/inbound/cases.js");
    const f = await fixture();
    const inbound = { messenger: f.messenger, classifier: f.classifier, now: () => START };
    await handleInbound(f.db, inbound, sms("AC broken"));
    await handleInbound(f.db, inbound, sms("Need a towel", "SMunknown", "+16265550999"));
    const [c] = await f.db.query<{ id: string }>("select id::text from recovery_cases");
    await resolveCase(f.db, c!.id, "Fixed", "staff", START);
    const app = createApp({ ...f.deps, now: () => later(3 * 1440), adminPassword: "pw" });
    expect((await app.request("/api/cases")).status).toBe(401);
    const headers = { Authorization: `Basic ${Buffer.from("admin:pw").toString("base64")}` };
    expect(await (await app.request("/api/cases", { headers })).json()).toMatchObject([{ id: c!.id, resolution: "Fixed" }]);
    expect(await (await app.request("/api/messages/unmatched", { headers })).json()).toMatchObject([{ body: "Need a towel" }]);
    expect((await app.request("/api/conversations/nope", { headers })).status).toBe(400);
  });

  it("sends a case reply to the actual inbound sender, even when a different consent phone exists", async () => {
    const f = await fixture();
    await f.db.query("update stays set consent_phone = '+16265550199', consented_at = $1", [START.toISOString()]);
    await handleInbound(f.db, { messenger: f.messenger, classifier: f.classifier, now: () => START }, sms("AC broken"));
    const [c] = await f.db.query<{ id: string }>("select id::text from recovery_cases");
    await replyToGuest(f.db, f.messenger, c!.id, "We can help", "staff", START);
    expect(f.messenger.sent.at(-1)?.to).toBe("+16265550101");
  });
});
