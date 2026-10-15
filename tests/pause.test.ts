import { describe, expect, it } from "vitest";
import { alertStatus } from "../src/alerts.js";
import { createApp, ingest, tick, type AppDeps } from "../src/app.js";
import type { Db } from "../src/db.js";
import { migrate, openPglite } from "../src/db.js";
import { seedDemo } from "../src/demo.js";
import { KeywordClassifier } from "../src/inbound/classify.js";
import { replyToGuest, resolveCase } from "../src/inbound/cases.js";
import { handleInbound } from "../src/inbound/handle.js";
import { ConsoleMessenger } from "../src/messaging.js";
import { pauseGuestTexts, resumeGuestTexts } from "../src/properties.js";
import { TemplateDrafter } from "../src/reviews/drafter.js";
import { MockReviewSource } from "../src/reviews/sources.js";
import { testDb } from "./helpers.js";

const GUEST = "+16265550150";
const DESK = "+16265559001";
const HOTEL = "+16265550000";
const csv = (status: string) =>
  `Confirmation,Guest Name,Phone,SMS Opt In,Room,Arrival,Departure,Status\n50,"PARK, JO",6265550150,Y,104,10/12/2026,10/15/2026,${status}\n`;

function harness(db: Db, start: string) {
  let clock = new Date(start);
  const messenger = new ConsoleMessenger(true);
  const classifier = new KeywordClassifier();
  const deps: AppDeps = {
    db, messenger, classifier, now: () => clock,
    source: new MockReviewSource({ sunset: [] }), drafter: new TemplateDrafter(),
  };
  let sid = 0;
  return {
    deps,
    set: (iso: string) => (clock = new Date(iso)),
    tick: () => tick(deps),
    ingest: (status: string, kind: "in_house" | "departures") => ingest(deps, "sunset", kind, csv(status)),
    text: (body: string) => handleInbound(db, { messenger, classifier, now: () => clock }, { from: GUEST, to: HOTEL, body, providerId: `SM${++sid}` }),
    to: (phone: string) => messenger.sent.filter((m) => m.to === phone),
  };
}

describe("pausing guest texts for a hotel", () => {
  it("holds every guest text, still alerts the desk, and sends each held text once on resume", async () => {
    const db = await testDb();
    const h = harness(db, "2026-10-12T23:00:00Z"); // 4 PM PT, arrival day
    await pauseGuestTexts(db, "sunset", "Raj", new Date("2026-10-12T22:00:00Z"));

    await h.ingest("In House", "in_house");
    await h.tick();
    expect(h.to(GUEST)).toHaveLength(0); // no welcome

    h.set("2026-10-13T17:05:00Z");
    await h.tick();
    expect(h.to(GUEST)).toHaveLength(0); // no mid-stay

    await h.text("The TV doesn't work");
    expect(h.to(DESK)).toHaveLength(1); // staff alerts are never paused
    expect(h.to(GUEST)).toHaveLength(0); // acknowledgement held

    const [c] = await db.query<{ id: string }>("select id::text from recovery_cases");
    await expect(replyToGuest(db, h.deps.messenger, c!.id, "On our way", "Maria", new Date("2026-10-13T17:10:00Z")))
      .rejects.toThrow(/paused/);
    await resolveCase(db, c!.id, null, "Maria", new Date("2026-10-13T17:10:00Z"));
    h.set("2026-10-13T17:45:00Z");
    await h.tick();
    expect(h.to(GUEST)).toHaveLength(0); // no follow-up

    // Nothing was dropped: the held work is still pending.
    // (The welcome expired on its own: it's only worth sending within 12 hours of check-in.)
    const [mid] = await db.query<{ status: string; result: string }>("select status, result from jobs where kind = 'mid_stay'");
    expect(mid).toEqual({ status: "pending", result: "guest texts paused" });

    await resumeGuestTexts(db, "sunset");
    h.set("2026-10-13T18:05:00Z");
    await h.tick();
    await h.tick();
    const kinds = h.to(GUEST).map((m) => m.body);
    expect(kinds.filter((b) => b.startsWith("Thanks for letting us know"))).toHaveLength(1);
    expect(kinds.filter((b) => b.includes("is everything better now"))).toHaveLength(1);
    expect(kinds.filter((b) => b.includes("how is everything with your room"))).toHaveLength(1);
    await db.close();
  });

  it("holds the review request while paused instead of dropping it", async () => {
    const db = await testDb();
    const h = harness(db, "2026-10-15T19:00:00Z");
    await h.ingest("Checked Out", "departures");
    await pauseGuestTexts(db, "sunset", "Raj", new Date("2026-10-15T19:00:00Z"));
    h.set("2026-10-15T21:00:00Z");
    await h.tick();
    expect(h.to(GUEST)).toHaveLength(0);
    const [job] = await db.query<{ status: string; result: string }>("select status, result from jobs where kind = 'review_request'");
    expect(job).toMatchObject({ status: "pending", result: "guest texts paused" });

    await resumeGuestTexts(db, "sunset");
    h.set("2026-10-15T21:20:00Z");
    await h.tick();
    expect(h.to(GUEST).filter((m) => m.body.includes("review"))).toHaveLength(1);
    await db.close();
  });

  it("shows as a warning on Operations while paused", async () => {
    const db = await testDb();
    await pauseGuestTexts(db, "sunset", "Raj", new Date("2026-10-15T19:00:00Z"));
    const { alerts } = await alertStatus(db, new Date("2026-10-15T19:05:00Z"), { scheduler: false });
    expect(alerts.find((a) => a.code === "guest_texts_paused")).toMatchObject({ severity: "warning" });
    await resumeGuestTexts(db, "sunset");
    expect((await alertStatus(db, new Date(), { scheduler: false })).alerts.find((a) => a.code === "guest_texts_paused")).toBeUndefined();
    await db.close();
  });
});

describe("pause and resume buttons", () => {
  async function demo() {
    const clock = new Date("2026-10-14T19:00:00Z");
    const db = await openPglite();
    await migrate(db);
    const source = await seedDemo(db, clock);
    const app = createApp({ db, source, messenger: new ConsoleMessenger(true), drafter: new TemplateDrafter(), now: () => clock, adminUser: "demo", adminPassword: "demo" });
    return { db, app };
  }
  async function signIn(app: ReturnType<typeof createApp>, user: string, password: string) {
    const login = await app.request("/login", { method: "POST", headers: { origin: "http://localhost" }, body: new URLSearchParams({ user, password, next: "/issues" }) });
    const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const page = await (await app.request("/issues", { headers: { accept: "text/html", cookie } })).text();
    const csrf = page.match(/name="_csrf" value="([a-f0-9]+)"/)![1]!;
    return (path: string) => app.request(path, { method: "POST", headers: { origin: "http://localhost", cookie, accept: "text/html" }, body: new URLSearchParams({ _csrf: csrf }) });
  }

  it("lets a GM pause and resume, records who did it, and refuses the front desk", async () => {
    const { db, app } = await demo();
    const [hotel] = await db.query<{ id: string }>("select id from properties order by name limit 1");
    const desk = await signIn(app, "maria", "desk-demo");
    await desk(`/hotels/${hotel!.id}/pause`);
    expect((await db.query("select 1 from properties where guest_texts_paused_at is not null"))).toHaveLength(0);

    const gm = await signIn(app, "demo", "demo");
    expect((await gm(`/hotels/${hotel!.id}/pause`)).status).toBe(302);
    const [p] = await db.query<{ guest_texts_paused_by: string }>("select guest_texts_paused_by from properties where id = $1", [hotel!.id]);
    expect(p!.guest_texts_paused_by).toBeTruthy();
    await gm(`/hotels/${hotel!.id}/resume`);
    expect((await db.query("select 1 from properties where guest_texts_paused_at is not null"))).toHaveLength(0);
    expect((await db.query<{ action: string }>("select action from audit_log where action like 'texts.%' order by id")).map((r) => r.action))
      .toEqual(["texts.pause", "texts.resume"]);
    await db.close();
  });
});
