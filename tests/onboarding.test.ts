import { describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../src/app.js";
import { parseMapping } from "../src/ingest/asiReport.js";
import { ConsoleMessenger } from "../src/messaging.js";
import { getProperty } from "../src/properties.js";
import { TemplateDrafter } from "../src/reviews/drafter.js";
import { MockReviewSource } from "../src/reviews/sources.js";
import { placeIdFrom, setupSteps } from "../src/web/hotels.js";
import { guessMapping, peek } from "../src/web/upload.js";
import { DEPARTURES_CSV, testDb } from "./helpers.js";

async function setup() {
  const db = await testDb();
  const deps: AppDeps = {
    db,
    messenger: new ConsoleMessenger(true),
    source: new MockReviewSource({}),
    drafter: new TemplateDrafter(),
    now: () => new Date("2026-10-14T20:00:00Z"),
    cronSecret: "s3cret",
  };
  return { app: createApp(deps), db };
}
const post = (app: ReturnType<typeof createApp>, path: string, body: Record<string, string> | FormData) =>
  app.request(path, { method: "POST", body: body instanceof FormData ? body : new URLSearchParams(body) });

// ASI exports from another hotel: different headers, first and last name in separate columns.
const OTHER_CSV = `Res #,First,Last,Mobile,Rm,Arrive,Depart,Status
20001,Anita,Patel,(626) 555-0101,104,10/10/2026,10/13/2026,Checked Out
20002,Marcus,Lee,626-555-0102,210,10/11/2026,10/13/2026,Checked Out
`;

describe("hotel setup", () => {
  it("adds a hotel from the form and shows it in the checklist", async () => {
    const { app, db } = await setup();
    const res = await post(app, "/hotels", {
      name: "Harbor House", timezone: "America/New_York", checkout_time: "10:30",
      sms_from: "(212) 555-0100", desk_phones: "212-555-0101, (212) 555-0102", gm_phone: "",
      google_place_id: "https://search.google.com/local/writereview?placeid=ChIJabc123", google_location: "", reply_mode: "auto_high", signoff: "Dana, GM",
    });
    expect(res.status).toBe(302);
    const p = await getProperty(db, "harbor-house");
    expect(p).toMatchObject({ timezone: "America/New_York", checkout_time: "10:30", sms_from: "+12125550100", google_place_id: "ChIJabc123", reply_mode: "auto_high" });
    expect(p.desk_phones).toEqual(["+12125550101", "+12125550102"]);
    expect(await (await app.request("/hotels")).text()).toContain("Harbor House");
  });

  it("keeps what was typed and says what's wrong", async () => {
    const { app, db } = await setup();
    const res = await post(app, "/hotels/sunset", { name: "Sunset Inn", timezone: "America/Los_Angeles", checkout_time: "11:00", sms_from: "call us", signoff: "Raj K" });
    expect(res.status).toBe(400);
    const page = await res.text();
    expect(page).toContain("a phone number we can text");
    expect(page).toContain('value="Raj K"');
    expect((await getProperty(db, "sunset")).signoff).toBe("Raj, General Manager");
  });

  it("editing keeps settings the form doesn't show", async () => {
    const { app, db } = await setup();
    await db.query("update properties set voice_notes = 'Warm' where id = 'sunset'");
    await post(app, "/hotels/sunset", { name: "Sunset Inn & Suites", timezone: "America/Los_Angeles", checkout_time: "11:00", sms_from: "+16265550000", desk_phones: "+16265559001", reply_mode: "approval_all" });
    const p = await getProperty(db, "sunset");
    expect(p.name).toBe("Sunset Inn & Suites");
    expect(p.voice_notes).toBe("Warm");
  });

  it("reads Place IDs from links and refuses links without one", () => {
    expect(placeIdFrom("ChIJxyz")).toBe("ChIJxyz");
    expect(placeIdFrom("https://search.google.com/local/writereview?placeid=ChIJ1")).toBe("ChIJ1");
    expect(() => placeIdFrom("https://g.page/r/abc/review")).toThrow(/Place ID/);
  });

  it("checklist turns green as steps are done", async () => {
    const { db } = await setup();
    const before = await setupSteps(db);
    expect(before.map((s) => s.done)).toEqual([true, true, true, false, false]);
    await db.query("insert into sync_state (key, value, updated_at) values ('import:sunset:in_house', '{}', now())");
    expect((await setupSteps(db))[3]!.done).toBe(true);
  });
});

describe("report check", () => {
  it("guesses columns from a different export and previews the first guests", async () => {
    const { headers } = peek(OTHER_CSV);
    const m = guessMapping(headers, parseMapping(null));
    expect(m.columns).toMatchObject({ confirmation: "Res #", firstName: "First", lastName: "Last", phone: "Mobile", room: "Rm", arrival: "Arrive", departure: "Depart" });
    expect(m.columns.fullName).toBeUndefined();
  });

  it("checks before importing, then imports and remembers the columns", async () => {
    const { app, db } = await setup();
    const form = new FormData();
    form.set("property", "sunset");
    form.set("kind", "departures");
    form.set("file", new File([OTHER_CSV], "other.csv"));
    const check = await (await post(app, "/upload/check", form)).text();
    expect(check).toContain("2 guests found");
    expect(check).toContain("Anita Patel");
    expect((await db.query("select 1 from stays")).length).toBe(0); // nothing imported yet

    const cols = [...check.matchAll(/<select name="(col_\w+)">[\s\S]*?<\/select>/g)].map((m) => [m[1]!, m[0].match(/<option value="([^"]*)" selected>/)?.[1] ?? ""]);
    const body = new URLSearchParams({ property: "sunset", kind: "departures", csv: OTHER_CSV, ...Object.fromEntries(cols) });
    const done = await (await app.request("/upload", { method: "POST", body })).text();
    expect(done).toContain("Report imported");
    expect((await db.query("select 1 from stays")).length).toBe(2);
    expect(((await getProperty(db, "sunset")).report_mapping as { columns: { room: string } }).columns.room).toBe("Rm");
  });

  it("flags a file with the wrong columns instead of importing nothing", async () => {
    const { app } = await setup();
    const form = new FormData();
    form.set("property", "sunset");
    form.set("kind", "in_house");
    form.set("file", new File(["Item,Qty\nTowels,4\n"], "inventory.csv"));
    const page = await (await post(app, "/upload/check", form)).text();
    expect(page).toContain("Choose a column for");
    expect(page).toMatch(/<button type="submit" disabled/);
  });

  it("still imports a file posted straight to /upload", async () => {
    const { app } = await setup();
    const form = new FormData();
    form.set("property", "sunset");
    form.set("kind", "departures");
    form.set("file", new File([DEPARTURES_CSV], "dep.csv"));
    expect(await (await post(app, "/upload", form)).text()).toContain("Report imported");
  });
});

describe("desk polish", () => {
  it("Resolve and open next goes to the next open issue in the same list", async () => {
    const { app, db } = await setup();
    const form = new FormData();
    form.set("property", "sunset");
    form.set("kind", "departures");
    form.set("file", new File([DEPARTURES_CSV], "dep.csv"));
    await post(app, "/upload", form);
    const stays = await db.query<{ id: string }>("select id::text from stays order by id");
    for (const s of stays.slice(0, 2)) await post(app, "/issues", { stay: s.id, summary: `Issue for ${s.id}` });
    const [a, b] = await db.query<{ id: string }>("select id::text from recovery_cases order by id");
    const page = await (await app.request(`/issues?id=${a!.id}`)).text();
    expect(page).toContain("Resolve and open next");
    const next = page.match(/name="next" value="([^"]+)"/)![1]!.replace(/&amp;/g, "&");
    const res = await post(app, `/issues/${a!.id}/resolve`, { resolution: "Fixed", next });
    expect(res.headers.get("location")).toBe(`/issues?id=${b!.id}&ok=resolved`);
    // An outside address is ignored.
    const res2 = await post(app, `/issues/${b!.id}/resolve`, { resolution: "Fixed", next: "https://evil.example/issues?" });
    expect(res2.headers.get("location")).toBe("/issues?ok=resolved");
  });

  it("uses the plain copy", async () => {
    const { app } = await setup();
    const page = await (await app.request("/issues")).text();
    expect(page).toContain("To do<b>");
    expect(page).not.toContain(">Todo<");
  });
});
