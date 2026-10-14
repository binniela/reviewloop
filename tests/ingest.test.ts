import { describe, expect, it } from "vitest";
import { normalizePhone, parseAsiReport, splitName } from "../src/ingest/asiReport.js";
import { reconcile } from "../src/ingest/reconcile.js";
import { DEPARTURES_CSV, testDb } from "./helpers.js";

const tz = "America/Los_Angeles";

describe("parseAsiReport", () => {
  it("normalizes names, contacts, dates, status, and checkout time", () => {
    const { reservations, errors } = parseAsiReport(DEPARTURES_CSV, { kind: "departures", timezone: tz });
    expect(errors).toEqual([]);
    expect(reservations).toHaveLength(3);
    const [a, b, c] = reservations;
    expect(a).toMatchObject({
      confirmation: "10001",
      firstName: "Anita",
      lastName: "Patel",
      phone: "+16265550101",
      smsOptIn: true,
      arrivalDate: "2026-10-10",
      departureDate: "2026-10-13",
      status: "checked_out",
      checkedOutAt: "2026-10-13T17:42:00.000Z",
    });
    expect(b).toMatchObject({ smsOptIn: false, checkedOutAt: null });
    expect(c).toMatchObject({ email: null, checkedOutAt: "2026-10-13T16:05:00.000Z" });
  });

  it("reports bad rows without failing the file and skips footer rows", () => {
    const csv = `Confirmation,Guest Name,Arrival,Departure,Status
1,Jane Doe,10/01/2026,10/03/2026,Checked Out
2,Bad Date,13/45/2026,10/03/2026,Checked Out
3,Backwards,10/05/2026,10/03/2026,Checked Out
,Total: 3,,,
`;
    const { reservations, errors } = parseAsiReport(csv, { kind: "reservations", timezone: tz });
    expect(reservations.map((r) => r.confirmation)).toEqual(["1"]);
    expect(errors.map((e) => e.row)).toEqual([2, 3]);
  });

  it("uses the status implied by the report kind when the status column is unknown", () => {
    const csv = `Confirmation,Guest Name,Arrival,Departure,Status\n9,Sam Wu,10/12/2026,10/14/2026,Stayover\n`;
    const { reservations } = parseAsiReport(csv, { kind: "in_house", timezone: tz });
    expect(reservations[0]!.status).toBe("in_house");
    const strict = parseAsiReport(csv, { kind: "reservations", timezone: tz });
    expect(strict.errors[0]!.message).toMatch(/unknown status/);
  });

  it("splits names and phones sensibly", () => {
    expect(splitName("MARY ANN O'NEIL")).toEqual(["Mary Ann", "O'Neil"]);
    expect(splitName("McDonald, Ian")).toEqual(["Ian", "McDonald"]);
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("555-0101")).toBeNull();
  });
});

describe("reconcile", () => {
  const now = new Date("2026-10-13T20:00:00Z");

  it("creates stays and emits created, checked_in, and checked_out events once", async () => {
    const db = await testDb();
    const { reservations } = parseAsiReport(DEPARTURES_CSV, { kind: "departures", timezone: tz });
    const first = await reconcile(db, "sunset", reservations, now);
    expect(first).toMatchObject({ created: 3, events: 9 });

    // Re-uploading the same report is a no-op.
    const second = await reconcile(db, "sunset", reservations, now);
    expect(second).toMatchObject({ created: 0, unchanged: 3, events: 0 });

    const out = await db.query<{ occurred_at: Date }>(
      "select occurred_at from events where type = 'guest.checked_out' and stay_id = (select id from stays where confirmation='10001')",
    );
    expect(new Date(out[0]!.occurred_at).toISOString()).toBe("2026-10-13T17:42:00.000Z");
  });

  it("tracks a stay through arrivals, in-house, and departures reports", async () => {
    const db = await testDb();
    const row = (status: string, dep = "10/14/2026") =>
      `Confirmation,Guest Name,Arrival,Departure,Status\n77,Kim Tran,10/12/2026,${dep},${status}\n`;
    const run = async (csv: string, kind: "arrivals" | "in_house" | "departures") =>
      reconcile(db, "sunset", parseAsiReport(csv, { kind, timezone: tz }).reservations, now);

    await run(row("Due In"), "arrivals");
    await run(row("In House"), "in_house");
    await run(row("In House", "10/15/2026"), "in_house"); // extended a night
    await run(row("Checked Out", "10/15/2026"), "departures");

    const types = (await db.query<{ type: string }>("select type from events order by id")).map((r) => r.type);
    expect(types).toEqual([
      "reservation.created",
      "guest.checked_in",
      "reservation.modified",
      "guest.checked_out",
    ]);
    const [mod] = await db.query<{ payload: { changed: string[] } }>(
      "select payload from events where type = 'reservation.modified'",
    );
    expect(mod!.payload.changed).toEqual(["departureDate"]);
  });

  it("ignores a stale report that would move a guest backwards", async () => {
    const db = await testDb();
    const csv = (s: string) => `Confirmation,Guest Name,Arrival,Departure,Status\n5,Al Ruiz,10/11/2026,10/13/2026,${s}\n`;
    await reconcile(db, "sunset", parseAsiReport(csv("Checked Out"), { kind: "departures", timezone: tz }).reservations, now);
    const res = await reconcile(
      db,
      "sunset",
      parseAsiReport(csv("In House"), { kind: "in_house", timezone: tz }).reservations,
      now,
    );
    expect(res).toMatchObject({ ignoredRegressions: 1, events: 0 });
    const [stay] = await db.query<{ status: string }>("select status from stays");
    expect(stay!.status).toBe("checked_out");
  });

  it("serializes overlapping reports and keeps checkout as the final state", async () => {
    const db = await testDb();
    const row = (status: string) => parseAsiReport(
      `Confirmation,Guest Name,Arrival,Departure,Status\n88,Kim Tran,10/12/2026,10/14/2026,${status}\n`,
      { kind: status === "In House" ? "in_house" : "departures", timezone: tz },
    ).reservations;
    await Promise.all([
      reconcile(db, "sunset", row("In House"), now),
      reconcile(db, "sunset", row("Checked Out"), now),
    ]);
    expect((await db.query<{ status: string }>("select status from stays where confirmation = '88'"))[0]?.status).toBe("checked_out");
    expect(await db.query("select id from events where type = 'guest.checked_out' and stay_id = (select id from stays where confirmation = '88')")).toHaveLength(1);
  });
});
