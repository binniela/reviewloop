import { describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/app.js";
import { migrate, openPglite, type Db } from "../src/db.js";
import { seedDemo } from "../src/demo.js";
import { ConsoleMessenger } from "../src/messaging.js";
import { TemplateDrafter } from "../src/reviews/drafter.js";
import { MockReviewSource } from "../src/reviews/sources.js";

let clock = new Date("2026-10-14T19:00:00Z");
const advance = (minutes: number) => (clock = new Date(clock.getTime() + minutes * 60_000));

async function demo(extra: Partial<AppDeps> = {}) {
  clock = new Date("2026-10-14T19:00:00Z");
  const db = await openPglite();
  await migrate(db);
  const source = await seedDemo(db, clock);
  const deps: AppDeps = {
    db, source, messenger: new ConsoleMessenger(true), drafter: new TemplateDrafter(),
    now: () => clock, adminUser: "demo", adminPassword: "demo", ...extra,
  };
  return { db, app: createApp(deps) };
}

type App = Awaited<ReturnType<typeof demo>>["app"];

/** A browser: keeps cookies, sends a same-origin header and the CSRF token from the last page it loaded. */
class Browser {
  cookies = new Map<string, string>();
  csrf = "";
  constructor(private app: App) {}
  private keep(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [k, ...v] = pair!.split("=");
      if (/Max-Age=0/i.test(c) || v.join("=") === "") this.cookies.delete(k!);
      else this.cookies.set(k!, v.join("="));
    }
    return res;
  }
  private get cookie() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "); }
  async get(path: string) {
    const res = this.keep(await this.app.request(path, { headers: { accept: "text/html", cookie: this.cookie } }));
    const body = await res.clone().text();
    this.csrf = body.match(/name="_csrf" value="([a-f0-9]+)"/)?.[1] ?? this.csrf;
    return res;
  }
  async post(path: string, fields: Record<string, string> = {}) {
    return this.keep(await this.app.request(path, {
      method: "POST",
      headers: { origin: "http://localhost", cookie: this.cookie },
      body: new URLSearchParams({ ...fields, ...(this.csrf ? { _csrf: this.csrf } : {}) }),
    }));
  }
  async login(user: string, password: string) {
    const res = await this.post("/login", { user, password, next: "/issues" });
    expect(res.status, `sign in as ${user}`).toBe(302);
    await this.get("/issues");
    return res;
  }
}

const openCase = async (db: Db) =>
  (await db.query<{ id: string }>("select id::text from recovery_cases where resolved_at is null and acknowledged_at is null order by id limit 1"))[0]!.id;

describe("per-person sign-in", () => {
  it("turns the old shared login into the first GM, keeps its history, and still accepts basic auth", async () => {
    const db = await openPglite();
    await migrate(db);
    await seedDemo(db, clock);
    // A database from before per-person sign-in: no staff, history under the shared username.
    await db.query("delete from staff_sessions");
    await db.query("delete from staff");
    await db.query("update recovery_cases set acknowledged_by = 'admin' where acknowledged_by is not null");
    await db.query("delete from audit_log");
    await db.query("delete from schema_migrations where name = '006_staff.sql'");
    await db.query("drop table audit_log, staff_sessions, desk_devices, staff");
    await migrate(db);
    const app = createApp({ db, source: new MockReviewSource(), messenger: new ConsoleMessenger(true), drafter: new TemplateDrafter(), now: () => clock, adminUser: "admin", adminPassword: "s3cret-pw" });

    // Sessions from the old cookie format no longer count.
    expect((await app.request("/api/status", { headers: { cookie: "rl_session=admin%7C99999999999999.x" } })).status).toBe(401);
    const basic = { Authorization: `Basic ${Buffer.from("admin:s3cret-pw").toString("base64")}` };
    expect((await app.request("/api/status", { headers: basic })).status).toBe(200);

    const gm = new Browser(app);
    await gm.login("admin", "s3cret-pw");
    const [staff] = await db.query<{ username: string; name: string; role: string }>("select username, name, role from staff");
    expect(staff).toEqual({ username: "admin", name: "Admin", role: "gm" });
    const imported = await db.query<{ staff_id: string | null; action: string }>("select staff_id::text, action from audit_log where imported");
    expect(imported.length).toBeGreaterThan(0);
    expect(imported.filter((r) => r.action === "case.take").every((r) => r.staff_id)).toBe(true);
    expect(await (await gm.get("/audit")).text()).toContain("Shared login");
  });

  it("signs the demo in with demo / demo as a GM", async () => {
    const { app } = await demo();
    const gm = new Browser(app);
    await gm.login("demo", "demo");
    const page = await (await gm.get("/")).text();
    expect(page).toContain("Waiting for you");
    expect(page).toContain('href="/staff"');
  });

  it("limits front desk staff to Guest issues, Upload and the QR sign", async () => {
    const { app, db } = await demo();
    const desk = new Browser(app);
    await desk.login("maria", "desk-demo");
    const issues = await (await desk.get("/issues")).text();
    expect(issues).toContain("Maria");
    expect(issues).not.toContain('href="/metrics"');
    expect(issues).not.toContain('href="/operations"');
    expect((await desk.get("/upload")).status).toBe(200);
    expect((await desk.get("/setup")).status).toBe(200);
    expect((await desk.get("/")).headers.get("location")).toBe("/issues");
    for (const path of ["/metrics", "/operations", "/staff", "/audit", "/hotels"]) {
      expect((await desk.get(path)).headers.get("location"), path).toBe("/issues?ok=gm-only");
    }
    // Only GMs can approve and post replies, even by posting the form directly.
    const [d] = await db.query<{ id: string }>("select id::text from reply_drafts where status = 'pending' limit 1");
    expect((await desk.post(`/drafts/${d!.id}/approve`, { text: "Thanks!" })).status).toBe(403);
    expect((await desk.post(`/drafts/${d!.id}/dismiss`)).status).toBe(403);
    expect((await db.query<{ status: string }>("select status from reply_drafts where id = $1", [d!.id]))[0]!.status).toBe("pending");
  });

  it("records who took, texted and resolved an issue, and who approved a reply", async () => {
    const { app, db } = await demo();
    const desk = new Browser(app);
    await desk.login("maria", "desk-demo");
    const id = await openCase(db);
    await desk.post(`/issues/${id}/ack`);
    advance(2);
    await desk.post(`/issues/${id}/resolve`, { resolution: "Plumber fixed it" });
    const [c] = await db.query<{ acknowledged_by: string }>("select acknowledged_by from recovery_cases where id = $1", [id]);
    expect(c!.acknowledged_by).toBe("Maria");
    expect((await desk.get(`/issues?id=${id}`)).status).toBe(200);

    const gm = new Browser(app);
    await gm.login("demo", "demo");
    const [d] = await db.query<{ id: string }>("select id::text from reply_drafts where status = 'pending' limit 1");
    await gm.get("/");
    expect((await gm.post(`/drafts/${d!.id}/approve`, { text: "Thank you for staying with us." })).status).toBe(302);

    const log = await db.query<{ actor: string; action: string; subject_id: string }>(
      "select actor, action, subject_id::text from audit_log where not imported and action not like 'signin%' order by id",
    );
    expect(log).toEqual([
      { actor: "Maria", action: "case.take", subject_id: id },
      { actor: "Maria", action: "case.resolve", subject_id: id },
      { actor: "Raj", action: "draft.approve", subject_id: d!.id },
    ]);
    const page = await (await gm.get("/audit?filter=issues")).text();
    expect(page).toContain("took an issue");
    expect(page).toContain("resolved an issue");
    expect(page).not.toContain("approved and posted");
  });

  it("lets the GM add, reset and remove staff, and signs removed or reset people out", async () => {
    const { app, db } = await demo();
    const gm = new Browser(app);
    await gm.login("demo", "demo");
    await gm.get("/staff");
    expect((await gm.post("/staff", { name: "Jamal Reed", role: "desk", pin: "1111" })).status).toBe(400);
    expect((await gm.post("/staff", { name: "Jamal Reed", role: "desk", pin: "4719", password: "jamal-pass-1" })).headers.get("location")).toBe("/staff?ok=added");
    const [jamal] = await db.query<{ id: string; username: string }>("select id::text, username from staff where name = 'Jamal Reed'");
    expect(jamal!.username).toBe("jamal");
    expect((await gm.post("/staff", { name: "jamal reed", role: "desk", pin: "4719" })).status).toBe(400);

    const desk = new Browser(app);
    await desk.login("jamal", "jamal-pass-1");
    expect((await desk.get("/issues")).status).toBe(200);

    await gm.post(`/staff/${jamal!.id}/reset`, { password: "new-pass-123" });
    expect((await desk.get("/issues")).headers.get("location")).toContain("/login");
    await desk.login("jamal", "new-pass-123");

    await gm.post(`/staff/${jamal!.id}/remove`);
    expect((await desk.get("/issues")).headers.get("location")).toContain("/login");
    expect((await desk.post("/login", { user: "jamal", password: "new-pass-123" })).status).toBe(401);
    expect(await (await gm.get("/audit?filter=staff")).text()).toContain("removed Jamal Reed");
  });

  it("never removes or demotes the last GM", async () => {
    const { app, db } = await demo();
    const gm = new Browser(app);
    await gm.login("demo", "demo");
    const [raj] = await db.query<{ id: string }>("select id::text from staff where username = 'demo'");
    await gm.get("/staff");
    await gm.post("/staff", { name: "Dana", role: "gm", password: "dana-pass-1" });
    const dana = new Browser(app);
    await dana.login("dana", "dana-pass-1");
    await dana.get("/staff");
    expect((await dana.post(`/staff/${raj!.id}/role`, { role: "desk" })).status).toBe(302);
    // Raj is front desk now, and Dana is the only GM left.
    expect((await gm.get("/staff")).headers.get("location")).toBe("/issues?ok=gm-only");
    const [d] = await db.query<{ id: string }>("select id::text from staff where username = 'dana'");
    await dana.get("/staff");
    expect((await dana.post(`/staff/${d!.id}/remove`)).headers.get("location")).toBe("/staff");
    expect((await db.query("select 1 from staff where role = 'gm' and removed_at is null")).length).toBe(1);
  });

  it("does not resurrect a removed deployment GM through login or Basic auth", async () => {
    const { app, db } = await demo();
    const raj = new Browser(app);
    await raj.login("demo", "demo");
    await raj.get("/staff");
    await raj.post("/staff", { name: "Dana", role: "gm", password: "dana-pass-1" });
    const dana = new Browser(app);
    await dana.login("dana", "dana-pass-1");
    await dana.get("/staff");
    const [row] = await db.query<{ id: string }>("select id::text from staff where username = 'demo'");
    await dana.post(`/staff/${row!.id}/remove`);
    expect((await raj.get("/staff")).headers.get("location")).toContain("/login");
    expect((await raj.post("/login", { user: "demo", password: "demo" })).status).toBe(401);
    const basic = { Authorization: `Basic ${Buffer.from("demo:demo").toString("base64")}` };
    expect((await app.request("/staff", { headers: basic })).status).toBe(401);
    const activeGm = { Authorization: `Basic ${Buffer.from("dana:dana-pass-1").toString("base64")}` };
    const activeDesk = { Authorization: `Basic ${Buffer.from("maria:desk-demo").toString("base64")}` };
    expect((await app.request("/staff", { headers: activeGm })).status).toBe(200);
    expect((await app.request("/staff", { headers: activeDesk })).status).toBe(403);
  });
});

describe("shared front desk PC", () => {
  async function deskPc() {
    const ctx = await demo({ deskIdleMinutes: 10 });
    const pc = new Browser(ctx.app);
    await pc.login("demo", "demo");
    await pc.get("/staff");
    expect((await pc.post("/staff/devices", { label: "Lobby" })).headers.get("location")).toBe("/staff?ok=device");
    expect(pc.cookies.has("rl_desk")).toBe(true);
    const staffId = async (username: string) => (await ctx.db.query<{ id: string }>("select id::text from staff where username = $1", [username]))[0]!.id;
    return { ...ctx, pc, staffId };
  }

  it("switches person by name and PIN, so the night clerk's actions are theirs", async () => {
    const { app, db, pc, staffId } = await deskPc();
    await pc.get("/issues");
    expect((await pc.post("/logout")).headers.get("location")).toBe("/switch");
    expect((await pc.get("/issues")).headers.get("location")).toBe("/switch?next=%2Fissues");
    const picker = await (await pc.get("/switch")).text();
    expect(picker).toContain("Who’s at the desk?");
    expect(picker).toContain("Maria");

    expect((await pc.post("/switch", { staff: await staffId("tom"), pin: "1357", next: "/issues" })).headers.get("location")).toBe("/issues");
    await pc.get("/issues");
    const id = await openCase(db);
    await pc.post(`/issues/${id}/ack`);
    expect((await db.query<{ acknowledged_by: string }>("select acknowledged_by from recovery_cases where id = $1", [id]))[0]!.acknowledged_by).toBe("Tom");
    const [entry] = await db.query<{ device: string }>("select device from audit_log where action = 'case.take' and not imported");
    expect(entry!.device).toBe("Lobby");

    // A PIN means nothing on a computer that isn't a registered desk PC.
    const elsewhere = new Browser(app);
    expect((await elsewhere.get("/switch")).headers.get("location")).toBe("/login?next=%2Fissues");
    expect((await elsewhere.post("/switch", { staff: await staffId("tom"), pin: "1357" })).headers.get("location")).toBe("/login");
  });

  it("locks a person's PIN after 5 wrong tries but not after many right ones", async () => {
    const { pc, staffId } = await deskPc();
    const maria = await staffId("maria");
    for (let i = 0; i < 8; i++) {
      await pc.post("/logout");
      expect((await pc.post("/switch", { staff: maria, pin: "2468" })).status).toBe(302);
    }
    await pc.post("/logout");
    for (let i = 0; i < 5; i++) expect((await pc.post("/switch", { staff: maria, pin: "0000" })).status).toBe(401);
    const locked = await pc.post("/switch", { staff: maria, pin: "2468" });
    expect(locked.status).toBe(429);
    expect(await locked.text()).toContain("Too many wrong PINs");
  });

  it("returns to the name screen after inactivity, but polling doesn't count as activity", async () => {
    const { app, db, pc, staffId } = await deskPc();
    await pc.post("/logout");
    await pc.post("/switch", { staff: await staffId("maria"), pin: "2468" });
    const page = await (await pc.get("/issues")).text();
    expect(page).toContain('id="rl-idle"');
    advance(5);
    expect((await app.request("/api/activity", { headers: { cookie: [...pc.cookies].map(([k, v]) => `${k}=${v}`).join("; ") } })).status).toBe(400);
    expect((await app.request("/api/activity", { headers: { "x-reviewloop-activity": "1", cookie: [...pc.cookies].map(([k, v]) => `${k}=${v}`).join("; ") } })).status).toBe(204);
    advance(9);
    expect((await pc.get("/api/status")).status).toBe(200); // still within 10 minutes of the last activity
    advance(3);
    expect((await pc.get("/issues")).headers.get("location")).toBe("/switch?idle=1");
    expect(await (await pc.get("/switch?idle=1")).text()).toContain("no activity");
    expect((await db.query("select 1 from audit_log where action = 'signout.idle' and actor = 'Maria'")).length).toBe(1);
  });

  it("doesn't time out sessions on a GM's own laptop", async () => {
    const { app } = await demo({ deskIdleMinutes: 10 });
    const laptop = new Browser(app);
    await laptop.login("demo", "demo");
    advance(120);
    expect((await laptop.get("/issues")).status).toBe(200);
    expect(await (await laptop.get("/issues")).text()).not.toContain('id="rl-idle"');
  });

  it("stops accepting PINs once the GM removes the desk PC", async () => {
    const { db, pc, staffId } = await deskPc();
    const [device] = await db.query<{ id: string }>("select id from desk_devices");
    await pc.get("/staff");
    expect((await pc.post(`/staff/devices/${device!.id}/remove`)).headers.get("location")).toBe("/login");
    expect((await pc.post("/switch", { staff: await staffId("maria"), pin: "2468" })).headers.get("location")).toBe("/login");
  });
});
