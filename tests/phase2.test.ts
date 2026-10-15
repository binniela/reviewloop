import { describe, expect, it } from "vitest";
import { createApp, ingest, tick, type AppDeps } from "../src/app.js";
import { approveConsent, recordConsent } from "../src/consent.js";
import type { Db } from "../src/db.js";
import { KeywordClassifier, enforceSafety, type Classification, type Classifier } from "../src/inbound/classify.js";
import { resolveCase, acknowledgeCase, replyToGuest } from "../src/inbound/cases.js";
import { handleInbound } from "../src/inbound/handle.js";
import { twilioSignature } from "../src/inbound/twilioSignature.js";
import { ConsoleMessenger } from "../src/messaging.js";
import { TemplateDrafter } from "../src/reviews/drafter.js";
import { MockReviewSource } from "../src/reviews/sources.js";
import { testDb } from "./helpers.js";

const GUEST = "+16265550150";
const DESK = "+16265559001";
const GM = "+16265559002";
const HOTEL = "+16265550000";

// Oct 12 arrival, 3 nights, opted in to SMS in the PMS.
const inHouse = (optIn = "Y", dep = "10/15/2026", status = "In House", phone = "6265550150") =>
  `Confirmation,Guest Name,Phone,SMS Opt In,Room,Arrival,Departure,Status\n50,"PARK, JO",${phone},${optIn},104,10/12/2026,${dep},${status}\n`;

function harness(db: Db, start: string, classifier: Classifier = new KeywordClassifier()) {
  let clock = new Date(start);
  const messenger = new ConsoleMessenger(true);
  const source = new MockReviewSource({ sunset: [] });
  const deps: AppDeps = {
    db,
    messenger,
    source,
    drafter: new TemplateDrafter(),
    classifier,
    now: () => clock,
    cronSecret: "s",
    twilioAuthToken: "tok",
    publicUrl: "https://rl.example",
  };
  let sid = 0;
  return {
    deps,
    messenger,
    source,
    set: (iso: string) => (clock = new Date(iso)),
    now: () => clock,
    tick: async () => {
      const r = await tick(deps);
      if (!("cases" in r) || !r.cases) throw new Error(`tick did not run cleanly: ${JSON.stringify(r)}`);
      return { ...r, cases: r.cases };
    },
    ingest: (csv: string, kind: "arrivals" | "in_house" | "departures") => ingest(deps, "sunset", kind, csv),
    text: (body: string, from = GUEST) =>
      handleInbound(db, { messenger, classifier, now: () => clock }, { from, to: HOTEL, body, providerId: `SM${++sid}` }),
    to: (phone: string) => messenger.sent.filter((m) => m.to === phone),
  };
}

async function jobs(db: Db) {
  return db.query<{ kind: string; status: string; run_at: Date; result: string | null }>(
    "select kind, status, run_at, result from jobs order by kind",
  );
}

describe("in-stay milestones", () => {
  it("welcomes at check-in and checks in the morning after arrival", async () => {
    const db = await testDb();
    const h = harness(db, "2026-10-12T23:00:00Z"); // 4 PM PT
    await h.ingest(inHouse(), "in_house");
    const mid = (await jobs(db)).find((j) => j.kind === "mid_stay")!;
    expect(new Date(mid.run_at).toISOString()).toBe("2026-10-13T17:00:00.000Z"); // 10 AM PT next day

    await h.tick();
    expect(h.to(GUEST).map((m) => m.body)).toEqual([
      "Hi Jo, welcome to Sunset Inn! If you need anything during your stay, just text this number.\nReply STOP to opt out.",
    ]);
    expect(h.to(GUEST)[0]!.from).toBe(HOTEL);

    h.set("2026-10-13T17:05:00Z");
    await h.tick();
    expect(h.to(GUEST).at(-1)!.body).toBe("Hi Jo, how is everything with your room so far? Reply here if anything needs attention.");
  });

  it("doesn't send a welcome the morning after arrival when the in-house report comes in late", async () => {
    const db = await testDb();
    const h = harness(db, "2026-10-13T14:30:00Z"); // 7:30 AM PT, the day after the 10/12 arrival
    await h.ingest(inHouse(), "in_house");
    expect((await jobs(db)).map((j) => j.kind)).not.toContain("welcome");
    h.set("2026-10-13T16:05:00Z");
    await h.tick();
    expect(h.to(GUEST)).toHaveLength(0);
    h.set("2026-10-13T17:05:00Z");
    await h.tick();
    expect(h.to(GUEST).map((m) => m.body)).toEqual(["Hi Jo, how is everything with your room so far? Reply here if anything needs attention."]);
  });

  it("skips a queued welcome once the arrival day has passed", async () => {
    const db = await testDb();
    const h = harness(db, "2026-10-13T05:30:00Z"); // 10:30 PM PT on arrival day: quiet hours hold the welcome
    await h.ingest(inHouse(), "in_house");
    await h.tick();
    h.set("2026-10-13T16:05:00Z"); // 9:05 AM next day
    await h.tick();
    expect(h.to(GUEST)).toHaveLength(0);
    expect((await jobs(db)).find((j) => j.kind === "welcome")).toMatchObject({ status: "skipped", result: "arrived before today" });
  });

  it("skips mid-stay for one-night stays and cancels in-stay messages at checkout", async () => {
    const db = await testDb();
    const h = harness(db, "2026-10-12T23:00:00Z");
    await h.ingest(inHouse("Y", "10/13/2026"), "in_house");
    expect((await jobs(db)).map((j) => j.kind)).toEqual(["review_request", "welcome"]);

    const db2 = await testDb();
    const h2 = harness(db2, "2026-10-12T15:00:00Z");
    await h2.ingest(inHouse("Y", "10/15/2026"), "in_house");
    // Early checkout before the mid-stay text goes out.
    await h2.ingest(inHouse("Y", "10/13/2026", "Checked Out"), "departures");
    const mid = (await jobs(db2)).find((j) => j.kind === "mid_stay")!;
    expect(mid).toMatchObject({ status: "cancelled", result: "guest checked out" });
  });

  it("doesn't text guests without consent, and holds texts during quiet hours", async () => {
    const db = await testDb();
    const h = harness(db, "2026-10-13T05:00:00Z"); // 10 PM PT
    await h.ingest(inHouse("N"), "in_house");
    await h.tick();
    expect((await jobs(db)).find((j) => j.kind === "welcome")).toMatchObject({ status: "skipped", result: "no SMS consent" });

    const db2 = await testDb();
    const h2 = harness(db2, "2026-10-13T05:00:00Z");
    await h2.ingest(inHouse("Y"), "in_house");
    await h2.tick();
    const w = (await jobs(db2)).find((j) => j.kind === "welcome")!;
    expect(w.result).toBe("quiet hours");
    expect(h2.to(GUEST)).toHaveLength(0);
  });

  it("skips the mid-stay check if the guest already has an open issue", async () => {
    const db = await testDb();
    const h = harness(db, "2026-10-12T23:00:00Z");
    await h.ingest(inHouse(), "in_house");
    await h.tick();
    h.set("2026-10-13T03:00:00Z"); // 8 PM PT
    await h.text("The shower has no hot water");
    h.set("2026-10-13T17:05:00Z");
    await h.tick();
    expect((await jobs(db)).find((j) => j.kind === "mid_stay")).toMatchObject({ status: "skipped", result: "issue already open" });
  });
});

describe("inbound texts", () => {
  async function setup(classifier?: Classifier) {
    const db = await testDb();
    const h = harness(db, "2026-10-13T17:00:00Z", classifier);
    await h.ingest(inHouse(), "in_house");
    return { db, h };
  }

  it("opens an issue, acknowledges the guest, and alerts the desk", async () => {
    const { db, h } = await setup();
    const res = await h.text("Hi, the AC in our room is broken and it's really hot");
    expect(res.action).toBe("case_opened");
    const [c] = await db.query<{ category: string; urgency: string; source: string }>("select category, urgency, source from recovery_cases");
    expect(c).toEqual({ category: "maintenance", urgency: "normal", source: "guest_text" });

    expect(h.to(GUEST).at(-1)!.body).toMatch(/^Thanks for letting us know, Jo/);
    expect(h.to(DESK)[0]!.body).toMatch(/^Jo Park, room 104: "Hi, the AC/);
    expect(h.to("desk@sunset.example")).toHaveLength(1);
    expect(h.to(GM)).toHaveLength(0); // not urgent

    // Follow-up texts attach to the same issue instead of opening another.
    const again = await h.text("Still hot in here");
    expect(again.action).toBe("case_updated");
    expect((await db.query("select 1 from recovery_cases")).length).toBe(1);
  });

  it("treats safety texts as urgent and alerts the GM, even if a model says otherwise", async () => {
    const lazy: Classifier = { classify: async (t) => enforceSafety(t, { sentiment: "positive", category: "praise", urgency: "low", summary: t, by: "claude" }) };
    const { db, h } = await setup(lazy);
    await h.text("I smell gas near the heater");
    const [c] = await db.query<{ urgency: string }>("select urgency from recovery_cases");
    expect(c!.urgency).toBe("urgent");
    expect(h.to(GM)[0]!.body).toMatch(/^URGENT/);
  });

  it("forwards requests without counting them as complaints", async () => {
    const { db, h } = await setup();
    const res = await h.text("Could we get extra towels please?");
    expect(res.action).toBe("case_opened");
    expect(await db.query("select kind from recovery_cases")).toEqual([{ kind: "request" }]);
    expect(h.to(DESK)[0]!.body).toMatch(/^Request from Jo Park/);
    expect(h.to(GUEST).at(-1)!.body).toBe("Got it, Jo. We've passed this to the front desk.");
  });

  it("does nothing for happy replies and scores the stay", async () => {
    const { db, h } = await setup();
    const res = await h.text("All good, thanks! Room is great");
    expect(res.action).toBe("no_action");
    expect(h.to(DESK)).toHaveLength(0);
    const [s] = await db.query<{ satisfaction: number }>("select satisfaction from stays");
    expect(s!.satisfaction).toBe(1);
  });

  it("ignores Twilio retries of the same message", async () => {
    const { db, h } = await setup();
    const sms = { from: GUEST, to: HOTEL, body: "TV doesn't work", providerId: "SMdup" };
    const deps = { messenger: h.messenger, classifier: new KeywordClassifier(), now: h.now };
    await handleInbound(db, deps, sms);
    expect((await handleInbound(db, deps, sms)).action).toBe("duplicate");
    expect(h.to(DESK)).toHaveLength(1);
  });

  it("honors STOP everywhere until START", async () => {
    const { db, h } = await setup();
    expect((await h.text("STOP")).action).toBe("opted_out");
    await h.text("the toilet is clogged"); // still reaches the desk...
    expect(h.to(DESK)).toHaveLength(1);
    expect(h.to(GUEST).filter((m) => m.body.startsWith("Thanks for letting"))).toHaveLength(0); // ...but no reply to the guest
    h.set("2026-10-15T20:00:00Z");
    await h.ingest(inHouse("Y", "10/15/2026", "Checked Out"), "departures");
    h.set("2026-10-17T19:00:00Z"); // past the 48h hold for the open issue
    await h.tick();
    const rr = (await jobs(db)).find((j) => j.kind === "review_request");
    expect(rr?.result).toMatch(/opted out/);
    expect((await h.text("start")).action).toBe("opted_in");
  });

  it("treats a plain-language opt-out like STOP: no reply to the guest, the desk is told", async () => {
    const { db, h } = await setup();
    const res = await h.text("Please stop texting me");
    expect(res.action).toBe("opted_out");
    expect(await db.query("select phone from opt_outs")).toEqual([{ phone: GUEST }]);
    expect(h.to(GUEST)).toHaveLength(0);
    expect(h.to(DESK)[0]!.body).toMatch(/^Jo Park, room 104 asked not to get texts/);
    expect(await db.query("select 1 from recovery_cases")).toHaveLength(0);
    // Nothing scheduled reaches them afterwards.
    h.set("2026-10-14T17:05:00Z");
    await h.tick();
    expect(h.to(GUEST)).toHaveLength(0);
  });

  it.each(["don't text me anymore", "UNSUBSCRIBE me please", "No more texts", "remove me from this list", "stop please"])(
    "records %j as an opt-out",
    async (body) => {
      const { db, h } = await setup();
      expect((await h.text(body)).action).toBe("opted_out");
      expect(await db.query("select 1 from opt_outs")).toHaveLength(1);
    },
  );

  it.each(["Can you stop by with towels?", "The noise won't stop", "Stop by the desk later?"])("does not treat %j as an opt-out", async (body) => {
    const { db, h } = await setup();
    expect((await h.text(body)).action).not.toBe("opted_out");
    expect(await db.query("select 1 from opt_outs")).toHaveLength(0);
  });

  it("forwards texts from numbers it can't match to a guest", async () => {
    const { h } = await setup();
    const res = await h.text("Room 210 the key card won't work", "+13105550199");
    expect(res.action).toBe("unmatched_forwarded");
    expect(h.to(DESK)[0]!.body).toMatch(/no matching guest/);
  });
});

describe("escalation and follow-up", () => {
  async function withIssue() {
    const db = await testDb();
    const h = harness(db, "2026-10-13T17:00:00Z");
    await h.ingest(inHouse(), "in_house");
    await h.tick();
    await h.text("There are stains on the sheets");
    const [c] = await db.query<{ id: string }>("select id::text from recovery_cases");
    return { db, h, caseId: c!.id };
  }

  it("alerts the GM if nobody responds in time", async () => {
    const { db, h } = await withIssue();
    h.set("2026-10-13T17:15:00Z");
    expect((await h.tick()).cases.escalated).toBe(0);
    h.set("2026-10-13T17:21:00Z");
    expect((await h.tick()).cases.escalated).toBe(1);
    expect(h.to(GM)[0]!.body).toMatch(/^No one has responded in 20 min: Jo Park, room 104/);
    h.set("2026-10-13T18:00:00Z");
    expect((await h.tick()).cases.escalated).toBe(0); // once only
    const [c] = await db.query<{ escalated_at: Date | null }>("select escalated_at from recovery_cases");
    expect(c!.escalated_at).not.toBeNull();
  });

  it("doesn't escalate once someone says they're on it", async () => {
    const { db, h, caseId } = await withIssue();
    await acknowledgeCase(db, caseId, "maria", h.now());
    h.set("2026-10-13T18:00:00Z");
    expect((await h.tick()).cases.escalated).toBe(0);
  });

  it("follows up after a fix and reopens if the guest says it's still not right", async () => {
    const { db, h, caseId } = await withIssue();
    await resolveCase(db, caseId, "Replaced sheets", "maria", h.now());
    h.set("2026-10-13T17:31:00Z");
    expect((await h.tick()).cases.followupsSent).toBe(1);
    expect(h.to(GUEST).at(-1)!.body).toBe("Hi Jo, just checking: is everything better now?");

    const res = await h.text("No, the new ones are dirty too");
    expect(res.action).toBe("case_reopened");
    const [c] = await db.query<{ resolved_at: Date | null; reopened_count: number }>("select resolved_at, reopened_count from recovery_cases");
    expect(c).toEqual({ resolved_at: null, reopened_count: 1 });
    expect(h.to(GM).at(-1)!.body).toMatch(/^REOPENED/);
  });

  it("leaves it closed when the guest is happy", async () => {
    const { db, h, caseId } = await withIssue();
    await resolveCase(db, caseId, "Replaced sheets", "maria", h.now());
    h.set("2026-10-13T17:31:00Z");
    await h.tick();
    expect((await h.text("Yes all good now, thank you!")).action).toBe("no_action");
    const [s] = await db.query<{ satisfaction: number }>("select satisfaction from stays");
    expect(s!.satisfaction).toBeGreaterThan(0);
  });

  it("lets staff text a guest who texted in, even without a prior opt-in", async () => {
    const db = await testDb();
    const h = harness(db, "2026-10-13T17:00:00Z");
    await h.ingest(inHouse("N"), "in_house");
    await h.text("Wifi isn't working");
    const [c] = await db.query<{ id: string }>("select id::text from recovery_cases");
    await replyToGuest(db, h.messenger, c!.id, "Sorry Jo, try network SunsetGuest. Coming up to reset the router.", "maria", h.now());
    expect(h.to(GUEST).at(-1)!.body).toMatch(/^Sorry Jo/);
  });
});

describe("check-in opt-in", () => {
  it("links to the guest in house and sends a confirmation", async () => {
    const db = await testDb();
    const h = harness(db, "2026-10-13T00:00:00Z");
    await h.ingest(inHouse("N"), "in_house");
    const res = await recordConsent(db, h.messenger, { propertyId: "sunset", lastName: "park", room: "104", phone: "(626) 555-0177", agreed: true }, h.now());
    expect(res.status).toBe("pending");
    if (res.status !== "pending") throw new Error("expected pending consent");
    expect((await approveConsent(db, h.messenger, res.consentId, "staff", h.now())).status).toBe("linked");
    expect(h.to("+16265550177")[0]!.body).toMatch(/^Hi Jo, welcome to Sunset Inn/);
    // Mid-stay now goes to the number they gave us.
    h.set("2026-10-13T17:05:00Z");
    await h.tick();
    expect(h.to("+16265550177").at(-1)!.body).toMatch(/how is everything/);
  });

  it("keeps sign-ups from before the report and links them on the next import", async () => {
    const db = await testDb();
    const h = harness(db, "2026-10-12T23:00:00Z");
    const res = await recordConsent(db, h.messenger, { propertyId: "sunset", lastName: "Park", room: "104", phone: "626-555-0177", agreed: true }, h.now());
    expect(res.status).toBe("pending");
    const r = await h.ingest(inHouse("N"), "in_house");
    expect(r.consentsLinked).toBe(0);
    if (res.status !== "pending") throw new Error("expected pending consent");
    expect((await approveConsent(db, h.messenger, res.consentId, "staff", h.now())).status).toBe("linked");
  });

  it("requires the box to be ticked and a real number", async () => {
    const db = await testDb();
    const m = new ConsoleMessenger(true);
    expect((await recordConsent(db, m, { propertyId: "sunset", lastName: "Park", room: "104", phone: "6265550177", agreed: false })).status).toBe("invalid");
    expect((await recordConsent(db, m, { propertyId: "sunset", lastName: "Park", room: "104", phone: "555", agreed: true })).status).toBe("invalid");
  });
});

describe("http", () => {
  it("verifies Twilio signatures on the webhook", async () => {
    const db = await testDb();
    const h = harness(db, "2026-10-13T17:00:00Z");
    await h.ingest(inHouse(), "in_house");
    const app = createApp(h.deps);
    const params = { From: GUEST, To: HOTEL, Body: "Sink is leaking", MessageSid: "SMhttp" };
    const sig = twilioSignature("tok", "https://rl.example/webhooks/twilio/sms", params);

    const bad = await app.request("/webhooks/twilio/sms", { method: "POST", body: new URLSearchParams(params), headers: { "X-Twilio-Signature": "nope" } });
    expect(bad.status).toBe(403);
    const ok = await app.request("/webhooks/twilio/sms", { method: "POST", body: new URLSearchParams(params), headers: { "X-Twilio-Signature": sig } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("<Response></Response>");
    const [c] = await db.query<{ urgency: string }>("select urgency from recovery_cases");
    expect(c!.urgency).toBe("urgent"); // leaks are a safety keyword

    const page = await (await app.request("/issues")).text();
    expect(page).toContain("Sink is leaking");
    expect(page).toContain("Nobody on it yet");
  });

  it("serves the check-in page publicly and the QR sign to staff", async () => {
    const db = await testDb();
    const h = harness(db, "2026-10-13T17:00:00Z");
    const app = createApp({ ...h.deps, adminPassword: "pw" });
    expect((await app.request("/checkin/sunset")).status).toBe(200);
    expect((await app.request("/setup")).status).toBe(401);
    const sign = await app.request("/setup", { headers: { Authorization: `Basic ${Buffer.from("admin:pw").toString("base64")}` } });
    const body = await sign.text();
    expect(body).toContain("<svg");
    expect(body).toContain("https://rl.example/checkin/sunset");
  });

  it("shows pilot metrics against the Google baseline", async () => {
    const db = await testDb();
    const h = harness(db, "2026-10-01T17:00:00Z");
    h.source.baseline.sunset = { count: 40, sum: 40 * 3.9 };
    await h.tick(); // baseline snapshot
    h.set("2026-10-14T17:00:00Z");
    h.source.reviews.sunset!.push(
      { externalId: "r1", author: "A B", rating: 5, body: "Great", reviewedAt: "2026-10-14T10:00:00Z", existingReply: null },
      { externalId: "r2", author: "C D", rating: 5, body: "Clean", reviewedAt: "2026-10-14T11:00:00Z", existingReply: null },
    );
    await h.tick();
    const page = await (await createApp(h.deps).request("/metrics")).text();
    expect(page).toContain("40 at start (+2)");
    expect(page).toContain("3.95");
    expect(page).toContain("Baseline taken 2026-10-01");
  });
});

describe("keyword classifier", () => {
  const k = new KeywordClassifier();
  const c = (t: string) => k.classify(t);
  it("labels common hotel texts sensibly", async () => {
    const expectC = async (t: string, want: Partial<Classification>) => expect(await c(t)).toMatchObject(want);
    await expectC("The AC is broken", { sentiment: "negative", category: "maintenance" });
    await expectC("Room smells like smoke", { sentiment: "negative", urgency: "urgent" });
    await expectC("Neighbors are really loud, can't sleep", { sentiment: "negative", category: "noise" });
    await expectC("Can I get a late checkout?", { category: "request", sentiment: "neutral" });
    await expectC("Everything is great thanks", { sentiment: "positive", category: "praise" });
    await expectC("What time is breakfast?", { category: "question", sentiment: "neutral" });
    await expectC("Not great, the room isn't clean", { sentiment: "negative", category: "cleanliness" });
    await expectC("Room is nice but the AC is really loud and kept us up", { sentiment: "negative" });
    await expectC("The AC is fixed now, thanks!", { sentiment: "positive" });
    await expectC("TV remote is missing", { sentiment: "negative", category: "maintenance" });
    await expectC("Love the pool", { sentiment: "positive", category: "praise" });
  });
});
