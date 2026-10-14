// End-to-end walkthrough with no credentials: in-memory database, printed messages, mock Google.
//   npm run demo
import { tick, ingest, type AppDeps } from "../src/app.js";
import { migrate, openPglite } from "../src/db.js";
import { ConsoleMessenger } from "../src/messaging.js";
import { drafterFromEnv } from "../src/reviews/drafter.js";
import { MockReviewSource } from "../src/reviews/sources.js";

let clock = new Date("2026-10-13T15:00:00Z"); // 8:00 AM Pacific
const db = await openPglite();
await migrate(db);
await db.query(
  `insert into properties (id, name, google_place_id, google_location, voice_notes, signoff)
   values ('sunset', 'Sunset Inn', 'ChIJdemo', 'accounts/1/locations/2',
           'Family-run motel off the 10. Warm, plain-spoken, short.', 'Raj, General Manager')`,
);
const source = new MockReviewSource({ sunset: [] });
const messenger = new ConsoleMessenger();
const deps: AppDeps = { db, messenger, source, drafter: drafterFromEnv(), now: () => clock };
const step = (s: string) => console.log(`\n=== ${s} (${clock.toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} PT)`);

step("Front desk uploads this morning's in-house report");
const inHouse = `Confirmation,Guest Name,Email,Phone,SMS Opt In,Room,Arrival,Departure,Status
20001,"PATEL, ANITA",anita@example.com,626-555-0101,Y,104,10/11/2026,10/13/2026,In House
20002,"LEE, MARCUS",marcus@example.com,626-555-0102,N,210,10/12/2026,10/13/2026,In House
20003,"GOMEZ, ANA",ana@example.com,626-555-0103,Y,118,10/12/2026,10/14/2026,In House`;
console.log(await ingest(deps, "sunset", "in_house", inHouse));

step("Guest in 104 texts about a loud AC; front desk logs it");
await db.query("insert into recovery_cases (stay_id, summary) select id, 'AC unit loud overnight' from stays where confirmation = '20001'");

clock = new Date("2026-10-13T19:00:00Z");
step("Departures report after checkout");
const departures = `Confirmation,Guest Name,Email,Phone,SMS Opt In,Room,Arrival,Departure,Status,Check Out Time
20001,"PATEL, ANITA",anita@example.com,626-555-0101,Y,104,10/11/2026,10/13/2026,Checked Out,10:42 AM
20002,"LEE, MARCUS",marcus@example.com,626-555-0102,N,210,10/12/2026,10/13/2026,Checked Out,11:05 AM`;
console.log(await ingest(deps, "sunset", "departures", departures));

clock = new Date("2026-10-13T20:30:00Z");
step("Scheduler tick: Marcus gets an email (no SMS consent); Anita is held while her issue is open");
console.log((await tick(deps)).jobs);

clock = new Date("2026-10-13T21:35:00Z");
step("Issue resolved (moved to a quiet room, comped breakfast); next tick sends Anita's request");
await db.query("update recovery_cases set resolved_at = now(), resolution = 'Moved to room 112 and comped breakfast'");
console.log((await tick(deps)).jobs);

clock = new Date("2026-10-14T18:00:00Z");
step("Next day: two Google reviews come in");
source.reviews.sunset!.push(
  { externalId: "accounts/1/locations/2/reviews/a", author: "Marcus L", rating: 5, body: "Spotless room, easy parking, friendly front desk.", reviewedAt: "2026-10-14T17:10:00Z", existingReply: null },
  { externalId: "accounts/1/locations/2/reviews/b", author: "Anita P", rating: 3, body: "AC was noisy the first night but they moved us quickly. Breakfast was decent.", reviewedAt: "2026-10-14T17:40:00Z", existingReply: null },
);
const t = await tick(deps);
console.log(t.reviews);
console.log("\nAuto-posted to Google:", source.replies);
const queue = await db.query("select d.draft, r.author, r.rating from reply_drafts d join reviews r on r.id = d.review_id where d.status = 'pending'");
console.log("Waiting for GM approval:", queue);
await db.close();
