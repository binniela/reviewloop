// End-to-end walkthrough of one stay, with no credentials: in-memory database, printed
// messages, mock Google, keyword triage (or Claude if ANTHROPIC_API_KEY is set).
//   npm run demo
import { ingest, tick, type AppDeps } from "../src/app.js";
import { approveConsent, recordConsent } from "../src/consent.js";
import { migrate, openPglite } from "../src/db.js";
import { classifierFromEnv } from "../src/inbound/classify.js";
import { resolveCase } from "../src/inbound/cases.js";
import { handleInbound } from "../src/inbound/handle.js";
import { ConsoleMessenger } from "../src/messaging.js";
import { drafterFromEnv } from "../src/reviews/drafter.js";
import { MockReviewSource } from "../src/reviews/sources.js";

try {
  process.loadEnvFile();
} catch {}

let clock = new Date("2026-10-11T22:30:00Z"); // Sun 3:30 PM Pacific
const db = await openPglite();
await migrate(db);
await db.query(
  `insert into properties (id, name, google_place_id, google_location, voice_notes, signoff,
                           sms_from, desk_phones, gm_phone)
   values ('sunset', 'Sunset Inn', 'ChIJdemo', 'accounts/1/locations/2',
           'Family-run motel off the 10. Warm, plain-spoken, short.', 'Raj, General Manager',
           '+16265550000', '{+16265559001}', '+16265559002')`,
);
const source = new MockReviewSource({ sunset: [] });
source.baseline.sunset = { count: 212, sum: 212 * 3.8 };
const messenger = new ConsoleMessenger(true);
const classifier = classifierFromEnv();
const deps: AppDeps = { db, messenger, source, drafter: drafterFromEnv(), classifier, now: () => clock };

const WHO: Record<string, string> = { "+16265559001": "FRONT DESK", "+16265559002": "GM", "+16265550101": "Anita (guest)" };
let shown = 0;
const flush = () => {
  for (const m of messenger.sent.slice(shown)) {
    const who = WHO[m.to] ?? m.to;
    console.log(`   -> ${who}: ${m.body.replace(/\n/g, " / ")}`);
  }
  shown = messenger.sent.length;
};
const at = (iso: string, label: string) => {
  clock = new Date(iso);
  const t = clock.toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", hour: "numeric", minute: "2-digit" });
  console.log(`\n[${t}] ${label}`);
};
let sid = 0;
const guestTexts = async (body: string) => {
  console.log(`   <- Anita: ${body}`);
  const r = await handleInbound(db, { messenger, classifier, now: () => clock }, {
    from: "+16265550101",
    to: "+16265550000",
    body,
    providerId: `SMdemo${++sid}`,
  });
  console.log(`   (${r.action}${"classification" in r ? `: ${r.classification.sentiment}, ${r.classification.category}, ${r.classification.urgency}` : ""})`);
  flush();
};
const run = async () => {
  await tick(deps);
  flush();
};

at("2026-10-11T22:30:00Z", "Baseline Google snapshot is taken on the first sync");
await run();

at("2026-10-11T23:15:00Z", "Anita checks in for 3 nights. She scans the QR code at the desk and opts in");
const report = (status: string, out = "") =>
  `Confirmation,Guest Name,Email,Phone,SMS Opt In,Room,Arrival,Departure,Status,Check Out Time
30001,"PATEL, ANITA",anita@example.com,,N,104,10/11/2026,10/14/2026,${status},${out}`;
await ingest(deps, "sunset", "in_house", report("In House"));
const consent = await recordConsent(db, messenger, { propertyId: "sunset", lastName: "Patel", room: "104", phone: "626-555-0101", agreed: true }, clock);
if (consent.status === "pending") await approveConsent(db, messenger, consent.consentId, "demo-staff", clock);
flush();
await run();

at("2026-10-12T17:00:00Z", "Mid-stay check, morning after arrival");
await run();
await guestTexts("Room is nice but the AC is really loud and kept us up");

at("2026-10-12T17:21:00Z", "Nobody at the desk tapped 'I'm on it' within 20 minutes");
await run();

at("2026-10-12T17:40:00Z", "Desk moves her to room 112 and resolves the issue");
const [c] = await db.query<{ id: string }>("select id::text from recovery_cases");
await resolveCase(db, c!.id, "Moved to 112, comped breakfast", "maria", clock);

at("2026-10-12T18:11:00Z", "Follow-up 30 minutes after the fix");
await run();
await guestTexts("Yes much better, thank you!");

at("2026-10-14T17:50:00Z", "Checkout");
await ingest(deps, "sunset", "departures", report("Checked Out", "10:50 AM"));
at("2026-10-14T19:55:00Z", "Two hours later: review request. Everyone is asked; her issue was resolved, so nothing to hold");
await run();

at("2026-10-15T18:00:00Z", "She leaves a review the next day");
source.reviews.sunset!.push({
  externalId: "accounts/1/locations/2/reviews/x",
  author: "Anita P",
  rating: 4,
  body: "AC was loud the first night but they moved us right away and checked back in. Friendly staff.",
  reviewedAt: "2026-10-15T16:30:00Z",
  existingReply: null,
});
await run();
console.log("   Reply awaiting approval:", await db.query("select draft, status from reply_drafts"));

const [s] = await db.query<{ satisfaction: number }>("select satisfaction from stays");
const [snap] = await db.query<{ review_count: number; avg_rating: number }>(
  "select review_count, avg_rating from review_snapshots order by day desc limit 1",
);
console.log(`\nStay satisfaction: ${s!.satisfaction}. Google now: ${snap!.review_count} reviews, ${snap!.avg_rating} average (baseline 212, 3.8).`);
await db.close();
