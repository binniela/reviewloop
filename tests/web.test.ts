import { describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/app.js";
import { migrate, openPglite } from "../src/db.js";
import { seedDemo } from "../src/demo.js";
import { ConsoleMessenger } from "../src/messaging.js";
import { TemplateDrafter } from "../src/reviews/drafter.js";
import { MockReviewSource } from "../src/reviews/sources.js";
import { testDb } from "./helpers.js";

async function setup(extra: Partial<AppDeps> = {}) {
  const db = await testDb();
  const deps: AppDeps = {
    db,
    messenger: new ConsoleMessenger(true),
    source: new MockReviewSource({ sunset: [] }),
    drafter: new TemplateDrafter(),
    adminUser: "raj",
    adminPassword: "pw",
    ...extra,
  };
  return { app: createApp(deps), db };
}

const HTML = { accept: "text/html" };

describe("staff sign-in", () => {
  it("serves the product page publicly and sends browsers at the bare domain to it", async () => {
    const { app } = await setup();
    const welcome = await app.request("/welcome", { headers: HTML });
    expect(welcome.status).toBe(200);
    expect(await welcome.text()).toContain("Every guest heard.");
    const root = await app.request("/", { headers: HTML });
    expect(root.headers.get("location")).toBe("/welcome");
  });

  it("sends browsers to the sign-in page and back to where they were going", async () => {
    const { app } = await setup();
    const res = await app.request("/issues", { headers: HTML });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?next=%2Fissues");
    expect((await app.request("/api/status")).status).toBe(401);
  });

  it("rejects a wrong password and signs in with the right one", async () => {
    const { app } = await setup();
    const bad = await app.request("/login", { method: "POST", headers: { Origin: "http://localhost" }, body: new URLSearchParams({ user: "raj", password: "nope", next: "/issues" }) });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("set-cookie")).toBeNull();

    const ok = await app.request("/login", { method: "POST", headers: { Origin: "http://localhost" }, body: new URLSearchParams({ user: "raj", password: "pw", next: "/metrics" }) });
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("/metrics");
    const cookie = ok.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/);
    const page = await app.request("/issues", { headers: { cookie: cookie.split(";")[0]! } });
    expect(page.status).toBe(200);
  });

  it("only redirects to paths on this site after sign-in", async () => {
    const { app } = await setup();
    const res = await app.request("/login", { method: "POST", headers: { Origin: "http://localhost" }, body: new URLSearchParams({ user: "raj", password: "pw", next: "//evil.example" }) });
    expect(res.headers.get("location")).toBe("/issues");
  });

  it("ignores a tampered session cookie", async () => {
    const { app } = await setup();
    const res = await app.request("/api/status", { headers: { cookie: "rl_session=raj%7C99999999999999.forged" } });
    expect(res.status).toBe(401);
  });
});

describe("status for badges and notifications", () => {
  it("counts open, unacknowledged and urgent issues and replies awaiting approval", async () => {
    const db = await openPglite();
    await migrate(db);
    const source = await seedDemo(db, new Date("2026-10-14T19:00:00Z"));
    const app = createApp({ db, source, messenger: new ConsoleMessenger(true), drafter: new TemplateDrafter() });
    const status = (await (await app.request("/api/status")).json()) as Record<string, unknown>;
    expect(status.open).toBeGreaterThan(0);
    expect(status.unacked).toBeGreaterThan(0);
    expect(status.urgent).toBe(1);
    expect(status.awaiting).toBeGreaterThan(0);
    expect(status.latestUrgent).toBe(true);
    expect(String(status.latest)).toContain("leaking");
  });
});

describe("guest issues inbox", () => {
  async function demoApp() {
    const db = await openPglite();
    await migrate(db);
    const source = await seedDemo(db, new Date("2026-10-14T19:00:00Z"));
    const app = createApp({ db, source, messenger: new ConsoleMessenger(true), drafter: new TemplateDrafter(), now: () => new Date("2026-10-14T19:00:00Z") });
    const [first] = await db.query<{ id: string }>("select id::text from recovery_cases where resolved_at is null order by id limit 1");
    return { app, db, caseId: first!.id };
  }

  it("never hard-refreshes, so a half-typed reply survives", async () => {
    const { app } = await demoApp();
    const page = await (await app.request("/issues")).text();
    expect(page).not.toContain('http-equiv="refresh"');
    expect(page).toContain('class="inbox');
  });

  it("stays on the conversation after taking an issue", async () => {
    const { app, caseId } = await demoApp();
    const res = await app.request(`/issues/${caseId}/ack`, { method: "POST" });
    expect(res.headers.get("location")).toBe(`/issues?id=${caseId}&ok=ack`);
  });

  it("keeps the typed text when a reply can't be sent", async () => {
    const { app, db, caseId } = await demoApp();
    // The guest texted STOP, so the reply is refused.
    await db.query(
      `insert into opt_outs (phone, opted_out_at) select s.phone, now() from recovery_cases c join stays s on s.id = c.stay_id where c.id = $1`,
      [caseId],
    );
    const res = await app.request(`/issues/${caseId}/reply`, { method: "POST", body: new URLSearchParams({ text: "On our way up" }) });
    expect(res.status).toBe(400);
    const page = await res.text();
    expect(page).toContain("On our way up");
    expect(page).toContain("Not sent");
  });

  it("connects a check-in sign-up only after the desk confirms in person", async () => {
    const { app, db } = await demoApp();
    await app.request("/checkin/sunset", { method: "POST", body: new URLSearchParams({ last_name: "Walsh", room: "107", phone: "626-555-0199", agree: "1" }) });
    const page = await (await app.request("/issues")).text();
    expect(page).toContain("check-in sign-up to confirm");
    const [{ id }] = (await db.query<{ id: string }>("select id::text from consents")) as [{ id: string }];
    expect((await app.request(`/consents/${id}/approve`, { method: "POST", body: new URLSearchParams({}) })).status).toBe(400);
    const ok = await app.request(`/consents/${id}/approve`, { method: "POST", body: new URLSearchParams({ verified: "1" }) });
    expect(ok.headers.get("location")).toBe("/issues?ok=connected");
    const [c] = await db.query<{ approved_by: string }>("select approved_by from consents");
    expect(c!.approved_by).toBe("admin");
  });
});

describe("operations, report freshness and undo", () => {
  const NOW = new Date("2026-10-14T19:00:00Z");
  async function demoApp() {
    const db = await openPglite();
    await migrate(db);
    const source = await seedDemo(db, NOW);
    const app = createApp({ db, source, messenger: new ConsoleMessenger(true), drafter: new TemplateDrafter(), now: () => NOW });
    return { app, db };
  }

  it("shows a text that didn't deliver on Operations, in the conversation, and in the badge count", async () => {
    const { app, db } = await demoApp();
    const [m] = await db.query<{ provider_id: string; case_id: string }>(
      "select provider_id, case_id::text from messages where direction = 'out' and case_id is not null and provider_id is not null limit 1",
    );
    await db.query("insert into sms_delivery_receipts (provider_id, status, rank, error_code, updated_at) values ($1, 'undelivered', 9, '30003', $2)", [
      m!.provider_id,
      NOW.toISOString(),
    ]);
    const ops = await (await app.request("/operations")).text();
    expect(ops).toContain("undelivered");
    expect(ops).toContain("code 30003");
    expect(await (await app.request(`/issues?id=${m!.case_id}`)).text()).toContain("Not delivered");
    const status = (await (await app.request("/api/status")).json()) as { problems: number };
    expect(status.problems).toBe(1);
  });

  it("flags hotels whose reports weren't uploaded today", async () => {
    const { app, db } = await demoApp();
    await db.query("update sync_state set updated_at = $1::timestamptz - interval '2 days' where key = 'import:harbor:in_house'", [NOW.toISOString()]);
    const issues = await (await app.request("/issues")).text();
    expect(issues).toContain("reports aren’t in for Harbor House");
    expect(await (await app.request("/upload")).text()).toContain("Not today");
  });

  it("brings a dismissed draft back with Undo", async () => {
    const { app, db } = await demoApp();
    const [d] = await db.query<{ id: string }>("select id::text from reply_drafts where status = 'pending' limit 1");
    const res = await app.request(`/drafts/${d!.id}/dismiss`, { method: "POST" });
    expect(res.headers.get("location")).toBe(`/?ok=dismissed&undo=${d!.id}`);
    expect(await (await app.request(res.headers.get("location")!)).text()).toContain(`/drafts/${d!.id}/restore`);
    await app.request(`/drafts/${d!.id}/restore`, { method: "POST" });
    const [after] = await db.query<{ status: string }>("select status from reply_drafts where id = $1", [d!.id]);
    expect(after!.status).toBe("pending");
  });
});

describe("inbox filters and Ask Reviewloop", () => {
  const NOW = new Date("2026-10-14T19:00:00Z");
  async function demoApp() {
    const db = await openPglite();
    await migrate(db);
    const source = await seedDemo(db, NOW);
    return createApp({ db, source, messenger: new ConsoleMessenger(true), drafter: new TemplateDrafter(), now: () => NOW });
  }

  it("searches, filters by hotel and view, and shows fixed issues under Follow up", async () => {
    const app = await demoApp();
    // Names in list rows (the Log an issue dropdown lists every guest, so match row markup).
    const rows = async (path: string) => [...(await (await app.request(path)).text()).matchAll(/<strong>([^<]+)<\/strong><span class="row-room">/g)].map((m) => m[1]);
    expect(await rows("/issues?q=toilet")).toEqual(["Ana Gomez"]);
    const harbor = await rows("/issues?hotel=harbor");
    expect(harbor).toContain("Dev Singh");
    expect(harbor).not.toContain("Ana Gomez");
    expect(await rows("/issues?view=urgent")).toEqual(["Ana Gomez"]);
    // Anita's AC issue was fixed and she said it's better, so it's Done, not Follow up.
    expect(await rows("/issues?tab=done")).toContain("Anita Patel");
    expect(await rows("/issues?tab=followup")).not.toContain("Anita Patel");
  });

  it("answers from live data and matches free-text questions to a topic", async () => {
    const app = await demoApp();
    const complaints = (await (await app.request("/api/ask?topic=complaints")).json()) as { bars: { label: string; value: number }[] };
    expect(complaints.bars[0]).toMatchObject({ label: "Maintenance" });
    const risk = (await (await app.request("/api/ask?q=what%20is%20about%20to%20escalate")).json()) as { title: string; items: { text: string }[] };
    expect(risk.title).toContain("nobody on it");
    expect(risk.items.some((i) => i.text.includes("GM already texted"))).toBe(true);
    const unknown = (await (await app.request("/api/ask?q=weather")).json()) as { followups: unknown[] };
    expect(unknown.followups).toHaveLength(3);
  });
});
