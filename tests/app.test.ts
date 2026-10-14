import { describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/app.js";
import { ConsoleMessenger } from "../src/messaging.js";
import { TemplateDrafter } from "../src/reviews/drafter.js";
import { MockReviewSource } from "../src/reviews/sources.js";
import { DEPARTURES_CSV, testDb } from "./helpers.js";

async function setup(extra: Partial<AppDeps> = {}) {
  const db = await testDb();
  const source = new MockReviewSource({
    sunset: [
      { externalId: "r/1", author: "Eli K", rating: 2, body: "Noisy <script>alert(1)</script>", reviewedAt: "2026-10-14T15:00:00Z", existingReply: null },
    ],
  });
  const messenger = new ConsoleMessenger(true);
  const deps: AppDeps = {
    db,
    messenger,
    source,
    drafter: new TemplateDrafter(),
    now: () => new Date("2026-10-14T20:00:00Z"),
    cronSecret: "s3cret",
    ...extra,
  };
  return { app: createApp(deps), db, source, messenger };
}

describe("http app", () => {
  it("protects machine endpoints with the cron secret", async () => {
    const { app } = await setup();
    expect((await app.request("/cron/tick")).status).toBe(401);
    expect((await app.request("/cron/tick", { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
  });

  it("rejects unsigned Twilio webhook mode in a production app", async () => {
    const db = await testDb();
    expect(() => createApp({ db, messenger: new ConsoleMessenger(true), source: new MockReviewSource(),
      drafter: new TemplateDrafter(), adminPassword: "pw", production: true, allowUnsignedWebhooks: true })).toThrow(/Unsigned Twilio/);
    await db.close();
  });

  it("ingests a report by API, then a tick sends requests and drafts replies", async () => {
    const { app, messenger, db } = await setup();
    const auth = { Authorization: "Bearer s3cret" };
    const res = await app.request("/api/ingest/sunset?kind=departures", { method: "POST", headers: auth, body: DEPARTURES_CSV });
    expect(await res.json()).toMatchObject({ created: 3, rows: 3, rowErrors: [] });

    const tick = (await (await app.request("/cron/tick", { headers: auth })).json()) as Record<string, any>;
    expect(tick.jobs.done).toBe(3);
    expect(tick.reviews.sunset).toMatchObject({ drafted: 1, awaitingApproval: 1 });
    expect(messenger.sent).toHaveLength(3);
    const [d] = await db.query("select status from reply_drafts");
    expect(d).toEqual({ status: "pending" });
  });

  it("shows the queue with review text escaped, and approving posts the edited reply", async () => {
    const { app, source, db } = await setup();
    await app.request("/cron/tick", { headers: { Authorization: "Bearer s3cret" } });
    const page = await (await app.request("/")).text();
    expect(page).toContain("Eli K");
    expect(page).toContain("&lt;script&gt;");
    expect(page).not.toContain("<script>alert");

    const [{ id }] = (await db.query<{ id: string }>("select id::text from reply_drafts")) as [{ id: string }];
    const res = await app.request(`/drafts/${id}/approve`, { method: "POST", body: new URLSearchParams({ text: "Sorry Eli, fixed." }) });
    expect(res.status).toBe(302);
    expect(source.replies).toEqual([{ externalId: "r/1", text: "Sorry Eli, fixed." }]);
  });

  it("requires basic auth for the staff UI when a password is set", async () => {
    const { app } = await setup({ adminUser: "raj", adminPassword: "pw" });
    expect((await app.request("/")).status).toBe(401);
    const ok = await app.request("/", { headers: { Authorization: `Basic ${Buffer.from("raj:pw").toString("base64")}` } });
    expect(ok.status).toBe(200);
  });

  it("requires a session-bound token and same origin for browser staff writes", async () => {
    const { app, db } = await setup({ adminUser: "raj", adminPassword: "pw" });
    await app.request("/api/ingest/sunset?kind=departures", { method: "POST", headers: { Authorization: "Bearer s3cret" }, body: DEPARTURES_CSV });
    const login = await app.request("/login", { method: "POST", headers: { Origin: "http://localhost" },
      body: new URLSearchParams({ user: "raj", password: "pw" }) });
    expect(login.status).toBe(302);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const page = await (await app.request("/issues", { headers: { Cookie: cookie } })).text();
    const token = page.match(/name="_csrf" value="([a-f0-9]+)"/)?.[1];
    expect(token).toBeTruthy();
    const [stay] = await db.query<{ id: string }>("select id::text from stays limit 1");
    const body = new URLSearchParams({ stay: stay!.id, summary: "Concern", _csrf: token! });
    expect((await app.request("/issues", { method: "POST", headers: { Cookie: cookie, Origin: "https://evil.example" }, body })).status).toBe(403);
    expect((await app.request("/issues", { method: "POST", headers: { Cookie: cookie, Origin: "http://localhost" },
      body: new URLSearchParams({ stay: stay!.id, summary: "Concern" }) })).status).toBe(403);
    expect((await app.request("/issues", { method: "POST", headers: { Cookie: cookie, Origin: "http://localhost" }, body })).status).toBe(302);
    expect(await db.query("select id from recovery_cases")).toHaveLength(1);
  });

  it("limits login attempts in the database across app instances", async () => {
    const { app, db } = await setup({ adminUser: "raj", adminPassword: "pw" });
    const second = createApp({ db, messenger: new ConsoleMessenger(true), source: new MockReviewSource(), drafter: new TemplateDrafter(), adminUser: "raj", adminPassword: "pw" });
    const request = () => ({ method: "POST", headers: { Origin: "http://localhost" }, body: new URLSearchParams({ user: "raj", password: "wrong" }) });
    for (let i = 0; i < 10; i++) expect((await app.request("/login", request())).status).toBe(401);
    expect((await second.request("/login", request())).status).toBe(429);
  });

  it("limits public check-in submissions across app instances", async () => {
    const { app, db } = await setup();
    const second = createApp({ db, messenger: new ConsoleMessenger(true), source: new MockReviewSource(), drafter: new TemplateDrafter() });
    const request = () => ({ method: "POST", body: new URLSearchParams({ last_name: "Guest", room: "101", phone: "6265550101", agree: "1" }) });
    for (let i = 0; i < 10; i++) expect((await app.request("/checkin/sunset", request())).status).toBe(200);
    expect((await second.request("/checkin/sunset", request())).status).toBe(429);
  });

  it("does not redirect sign-in to a backslash external host", async () => {
    const { app } = await setup({ adminUser: "raj", adminPassword: "pw" });
    const res = await app.request("/login", { method: "POST", headers: { Origin: "http://localhost" },
      body: new URLSearchParams({ user: "raj", password: "pw", next: "/\\evil.example" }) });
    expect(res.headers.get("location")).toBe("/issues");
  });

  it("uploads a CSV through the form and logs and resolves a guest issue", async () => {
    const { app, db } = await setup();
    const form = new FormData();
    form.set("property", "sunset");
    form.set("kind", "departures");
    form.set("file", new File([DEPARTURES_CSV + `10009,"X, Y",,,,,,13/99/2026,10/13/2026,Checked Out,\n`], "dep.csv"));
    const page = await (await app.request("/upload", { method: "POST", body: form })).text();
    expect(page).toContain("Rows with problems");
    expect(page).toContain("unrecognized arrival date");

    const [stay] = await db.query<{ id: string }>("select id::text from stays where confirmation = '10001'");
    await app.request("/issues", { method: "POST", body: new URLSearchParams({ stay: stay!.id, summary: "AC loud" }) });
    expect(await (await app.request("/issues")).text()).toContain("AC loud");
    const [c] = await db.query<{ id: string }>("select id::text from recovery_cases");
    await app.request(`/issues/${c!.id}/resolve`, { method: "POST", body: new URLSearchParams({ resolution: "Moved rooms" }) });
    const [after] = await db.query<{ resolution: string }>("select resolution from recovery_cases");
    expect(after!.resolution).toBe("Moved rooms");
  });
});
