import { describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { parseAsiReport } from "../src/ingest/asiReport.js";
import { reconcile } from "../src/ingest/reconcile.js";
import { ConsoleMessenger } from "../src/messaging.js";
import { processEvents, runDueJobs } from "../src/milestones/engine.js";
import { DEPARTURES_CSV, testDb } from "./helpers.js";

const tz = "America/Los_Angeles";
const at = (iso: string) => () => new Date(iso);

async function ingest(db: Db, csv: string, kind: "arrivals" | "in_house" | "departures", now: string) {
  await reconcile(db, "sunset", parseAsiReport(csv, { kind, timezone: tz }).reservations, new Date(now));
  await processEvents(db);
}

async function job(db: Db, confirmation: string) {
  const [j] = await db.query<{ status: string; run_at: Date; result: string | null }>(
    "select j.status, j.run_at, j.result from jobs j join stays s on s.id = j.stay_id where s.confirmation = $1",
    [confirmation],
  );
  return j!;
}

describe("review request milestone", () => {
  it("schedules 2 hours after actual checkout, uses SMS only with consent, falls back to email", async () => {
    const db = await testDb();
    await ingest(db, DEPARTURES_CSV, "departures", "2026-10-13T19:00:00Z");

    // 10001 checked out 10:42 PT -> request at 12:42 PT (19:42Z)
    expect(new Date((await job(db, "10001")).run_at).toISOString()).toBe("2026-10-13T19:42:00.000Z");
    // 10002 has no checkout time -> property checkout 11:00 PT + 2h = 20:00Z
    expect(new Date((await job(db, "10002")).run_at).toISOString()).toBe("2026-10-13T20:00:00.000Z");

    const messenger = new ConsoleMessenger(true);
    const summary = await runDueJobs(db, { messenger, now: at("2026-10-13T20:30:00Z") });
    expect(summary).toMatchObject({ done: 3 });

    const byTo = Object.fromEntries(messenger.sent.map((m) => [m.to, m]));
    expect(byTo["+16265550101"]!.channel).toBe("sms");
    expect(byTo["+16265550101"]!.body).toContain("Hi Anita, thanks for staying at Sunset Inn");
    expect(byTo["+16265550101"]!.body).toContain("placeid=PLACE123");
    expect(byTo["+16265550101"]!.body).toContain("Reply STOP");
    expect(byTo["marcus@example.com"]!.channel).toBe("email"); // declined SMS
    expect(byTo["+16265550103"]!.channel).toBe("sms");

    // Running again never double-sends.
    const again = await runDueJobs(db, { messenger, now: at("2026-10-13T23:00:00Z") });
    expect(again.done).toBe(0);
    expect(messenger.sent).toHaveLength(3);
  });

  it("schedules from the reservation, follows date changes, and cancels with the reservation", async () => {
    const db = await testDb();
    const csv = (dep: string, status: string) =>
      `Confirmation,Guest Name,Phone,SMS Opt In,Arrival,Departure,Status\n50,Jo Park,6265550150,Y,10/12/2026,${dep},${status}\n`;
    await ingest(db, csv("10/14/2026", "Due In"), "arrivals", "2026-10-12T15:00:00Z");
    expect(new Date((await job(db, "50")).run_at).toISOString()).toBe("2026-10-14T20:00:00.000Z");

    await ingest(db, csv("10/16/2026", "In House"), "in_house", "2026-10-13T15:00:00Z");
    expect(new Date((await job(db, "50")).run_at).toISOString()).toBe("2026-10-16T20:00:00.000Z");

    await ingest(db, csv("10/16/2026", "Cancelled"), "arrivals", "2026-10-13T16:00:00Z");
    expect((await job(db, "50")).status).toBe("cancelled");
  });

  it("waits for the checkout to be reported instead of messaging a guest still in house", async () => {
    const db = await testDb();
    const csv = `Confirmation,Guest Name,Phone,SMS Opt In,Arrival,Departure,Status\n60,Lu Chen,6265550160,Y,10/12/2026,10/13/2026,In House\n`;
    await ingest(db, csv, "in_house", "2026-10-13T08:00:00Z");
    const messenger = new ConsoleMessenger(true);

    const s1 = await runDueJobs(db, { messenger, now: at("2026-10-13T20:05:00Z") });
    expect(s1.deferred).toBe(1);
    expect((await job(db, "60")).result).toBe("waiting for checkout");
    expect(messenger.sent).toHaveLength(0);

    // Two days later and still never reported as checked out: give up rather than guess.
    const s2 = await runDueJobs(db, { messenger, now: at("2026-10-15T20:00:00Z") });
    expect(s2.skipped).toBe(1);
    expect((await job(db, "60")).result).toBe("checkout never reported");
  });

  it("holds the request while a recovery case is open, then sends to the guest anyway", async () => {
    const db = await testDb();
    await ingest(db, DEPARTURES_CSV, "departures", "2026-10-13T19:00:00Z");
    await db.query(
      "insert into recovery_cases (stay_id, summary) select id, 'AC loud in 104' from stays where confirmation = '10001'",
    );
    const messenger = new ConsoleMessenger(true);

    await runDueJobs(db, { messenger, now: at("2026-10-13T20:30:00Z") });
    expect((await job(db, "10001")).result).toBe("recovery case open");
    expect(messenger.sent.map((m) => m.to)).not.toContain("+16265550101");

    // Unresolved for 48h after checkout: the guest is still asked. Nobody is filtered out.
    await runDueJobs(db, { messenger, now: at("2026-10-15T18:00:00Z") });
    expect((await job(db, "10001")).result).toBe("sent by sms after recovery hold");
  });

  it("sends as soon as the case is resolved", async () => {
    const db = await testDb();
    await ingest(db, DEPARTURES_CSV, "departures", "2026-10-13T19:00:00Z");
    await db.query(
      "insert into recovery_cases (stay_id, summary) select id, 'Late towels' from stays where confirmation = '10003'",
    );
    const messenger = new ConsoleMessenger(true);
    await runDueJobs(db, { messenger, now: at("2026-10-13T20:30:00Z") });
    await db.query("update recovery_cases set resolved_at = now(), resolution = 'Comped breakfast'");
    await runDueJobs(db, { messenger, now: at("2026-10-13T21:31:00Z") });
    expect((await job(db, "10003")).status).toBe("done");
  });

  it("defers texts during quiet hours to the next morning", async () => {
    const db = await testDb();
    const csv = `Confirmation,Guest Name,Phone,SMS Opt In,Arrival,Departure,Status,Check Out Time\n70,Bo Diaz,6265550170,Y,10/12/2026,10/13/2026,Checked Out,7:30 PM\n`;
    await ingest(db, csv, "departures", "2026-10-14T03:00:00Z");
    const messenger = new ConsoleMessenger(true);
    // 9:30 PM PT is inside quiet hours (8 PM to 9 AM).
    await runDueJobs(db, { messenger, now: at("2026-10-14T04:30:00Z") });
    const j = await job(db, "70");
    expect(j.result).toBe("quiet hours");
    expect(new Date(j.run_at).toISOString()).toBe("2026-10-14T16:00:00.000Z"); // 9:00 AM PT
    expect(messenger.sent).toHaveLength(0);
  });

  it("retries provider failures with backoff", async () => {
    const db = await testDb();
    await ingest(db, DEPARTURES_CSV, "departures", "2026-10-13T19:00:00Z");
    const failing = { send: async () => Promise.reject(new Error("Twilio 503")) };
    const s = await runDueJobs(db, { messenger: failing, now: at("2026-10-13T20:30:00Z") });
    expect(s.retrying).toBe(3);
    expect((await job(db, "10001")).result).toBe("retrying: Twilio 503");
  });
});
