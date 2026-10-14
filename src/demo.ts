import { DateTime } from "luxon";
import { ingest, tick, type AppDeps } from "./app.js";
import type { Db } from "./db.js";
import { acknowledgeCase, replyToGuest, resolveCase } from "./inbound/cases.js";
import { KeywordClassifier } from "./inbound/classify.js";
import { handleInbound } from "./inbound/handle.js";
import { ConsoleMessenger } from "./messaging.js";
import { TemplateDrafter } from "./reviews/drafter.js";
import { MockReviewSource } from "./reviews/sources.js";

/**
 * Fills an empty database with two hotels and a believable last few days, timed relative to
 * `now`. Used by hosted demos (no DATABASE_URL) so every page has something on it. Runs the real
 * pipeline (imports, inbound triage, timers, review sync) rather than inserting rows by hand.
 */
export async function seedDemo(db: Db, now = new Date()) {
  const source = new MockReviewSource({ sunset: [], harbor: [] });
  source.baseline.sunset = { count: 212, sum: 212 * 3.8 };
  source.baseline.harbor = { count: 148, sum: 148 * 4.1 };
  const [{ n } = { n: 0 }] = await db.query<{ n: number }>("select count(*)::int as n from properties");
  if (n > 0) return source;

  await db.query(
    `insert into properties (id, name, timezone, google_place_id, google_location, voice_notes, signoff, sms_from, desk_phones, gm_phone)
     values ('sunset', 'Sunset Inn', 'America/Los_Angeles', 'demo-sunset', 'accounts/1/locations/1',
             'Family-run motel off the 10. Warm, plain-spoken, short.', 'Raj, General Manager',
             '+16265550000', '{+16265559001}', '+16265559002'),
            ('harbor', 'Harbor House', 'America/Los_Angeles', 'demo-harbor', 'accounts/1/locations/2',
             'Small boutique hotel by the marina. Friendly, a little polished.', 'Dana, General Manager',
             '+13105550000', '{+13105559001}', '+13105559002')`,
  );

  let clock = now;
  const messenger = new ConsoleMessenger(true);
  const classifier = new KeywordClassifier();
  const deps: AppDeps = { db, messenger, source, drafter: new TemplateDrafter(), classifier, now: () => clock };
  const at = (minutesAgo: number) => (clock = new Date(now.getTime() - minutesAgo * 60_000));
  const atLocal = (dayOffset: number, hour: number, minute = 0) =>
    (clock = DateTime.fromJSDate(now, { zone: "America/Los_Angeles" }).plus({ days: dayOffset }).set({ hour, minute }).toJSDate());
  const day = (offset: number) => DateTime.fromJSDate(now, { zone: "America/Los_Angeles" }).plus({ days: offset }).toFormat("MM/dd/yyyy");
  let sid = 0;
  const text = (to: string, from: string, body: string) =>
    handleInbound(db, { messenger, classifier, now: () => clock }, { from, to, body, providerId: `SMdemo${++sid}` });
  const caseFor = async (phone: string) =>
    (await db.query<{ id: string }>(
      `select c.id::text from recovery_cases c join stays s on s.id = c.stay_id where s.phone = $1 order by c.id desc limit 1`,
      [phone],
    ))[0]?.id;

  const imports: [string, "departures" | "in_house", string][] = [];
  const load = async (property: string, kind: "departures" | "in_house", csv: string) => {
    imports.push([property, kind, csv]);
    await ingest(deps, property, kind, csv);
  };
  const header = "Confirmation,Guest Name,Email,Phone,SMS Opt In,Room,Arrival,Departure,Status,Check Out Time";

  // Four days ago: first sync records the Google baseline.
  at(4 * 1440);
  await tick(deps);

  // Checkouts from two days ago. Review requests go out two hours after checkout.
  atLocal(-2, 11, 30);
  await load("sunset", "departures", `${header}
20001,"OKAFOR, JUDE",,626-555-0141,Y,201,${day(-4)},${day(-2)},Checked Out,10:20 AM
20002,"CHEN, LILY",,626-555-0142,Y,115,${day(-4)},${day(-2)},Checked Out,9:40 AM
20003,"BRANDT, OSCAR",,626-555-0143,N,122,${day(-4)},${day(-2)},Checked Out,11:05 AM`);
  await load("harbor", "departures", `${header}
40001,"ROSSI, ELENA",,310-555-0151,Y,3B,${day(-4)},${day(-2)},Checked Out,10:00 AM
40002,"PARK, SAMUEL",,310-555-0152,Y,2A,${day(-4)},${day(-2)},Checked Out,10:30 AM`);
  atLocal(-2, 13);
  await tick(deps);

  // Who's in house tonight.
  at(20 * 60);
  await load("sunset", "in_house", `${header}
30001,"PATEL, ANITA",,626-555-0101,Y,104,${day(-1)},${day(2)},In House,
30002,"LEE, MARCUS",,626-555-0102,Y,210,${day(-1)},${day(1)},In House,
30003,"GOMEZ, ANA",,626-555-0103,Y,118,${day(0)},${day(2)},In House,
30004,"NGUYEN, KIM",,626-555-0104,Y,220,${day(-2)},${day(1)},In House,
30005,"WALSH, TOM",,626-555-0105,Y,107,${day(-1)},${day(1)},In House,`);
  await load("harbor", "in_house", `${header}
50001,"SINGH, DEV",,310-555-0161,Y,4C,${day(-1)},${day(1)},In House,
50002,"MORALES, ROSA",,310-555-0162,Y,1D,${day(-2)},${day(2)},In House,`);

  // A fixed issue from this afternoon, with the follow-up answered.
  at(190);
  await text("+16265550000", "+16265550101", "Room is nice but the AC is really loud and kept us up");
  at(178);
  await acknowledgeCase(db, (await caseFor("+16265550101"))!, "maria", clock);
  at(170);
  await resolveCase(db, (await caseFor("+16265550101"))!, "Moved to 112, comped breakfast", "maria", clock);
  at(139);
  await tick(deps);
  await text("+16265550000", "+16265550101", "Yes much better, thank you!");

  // Reviews from those guests: 4 and 5 stars post themselves, the rest wait for the GM.
  at(150);
  source.reviews.sunset!.push(
    { externalId: "demo/s1", author: "Jude Okafor", rating: 5, body: "Spotless room and Raj at the desk was great. Easy freeway access. Will stay again.", reviewedAt: clock.toISOString(), existingReply: null },
    { externalId: "demo/s2", author: "Lily Chen", rating: 2, body: "Room was fine but the parking lot lights shine straight into the window all night. Asked for a different room and was told they were full.", reviewedAt: clock.toISOString(), existingReply: null },
    { externalId: "demo/s3", author: "Oscar B", rating: 3, body: "Good value for the price. Breakfast ran out of eggs by 8:30.", reviewedAt: clock.toISOString(), existingReply: null },
  );
  source.reviews.harbor!.push(
    { externalId: "demo/h1", author: "Elena Rossi", rating: 4, body: "Lovely little hotel, the harbor view from 3B is the best. Shower pressure could be better.", reviewedAt: clock.toISOString(), existingReply: null },
    { externalId: "demo/h2", author: "Samuel Park", rating: 1, body: "Checked in at 11pm and our key cards didn't work. Waited 25 minutes for someone to come back to the desk.", reviewedAt: clock.toISOString(), existingReply: null },
  );
  at(120);
  await tick(deps);

  // Live issues on the board right now.
  at(52);
  await text("+13105550000", "+13105550161", "Wifi isn't working, it keeps dropping. I have a work call at 9");
  at(46);
  const wifi = (await caseFor("+13105550161"))!;
  await acknowledgeCase(db, wifi, "jordan", clock);
  await replyToGuest(db, messenger, wifi, "So sorry Dev. Bringing a new router up to 4C in 10 minutes.", "jordan", clock);
  at(38);
  await text("+16265550000", "+16265550105", "The room smells like cigarettes, we booked non smoking");
  at(26);
  await text("+16265550000", "+16265550104", "Hi, could we get 2 extra towels?");
  at(14);
  await text("+16265550000", "+16265550102", "There's no hot water in the shower");
  at(6);
  await text("+16265550000", "+16265550103", "The toilet is leaking all over the bathroom floor");
  at(3);
  await text("+13105550000", "+13105550162", "Everything is great, thanks for the welcome text!");

  // This morning's reports were uploaded on time (re-importing unchanged rows is a no-op).
  at(20);
  for (const [property, kind, csv] of imports) await ingest(deps, property, kind, csv);

  // Bring timers up to now (the 38-minute-old smell complaint escalates to the GM).
  at(0);
  await tick(deps);
  return source;
}
