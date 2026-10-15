# Fix plan: from "free test" to "paid pilot"

Written 2026-10-14 from the MVP readiness review. Goal: nothing texts the wrong person or keeps
texting someone who said stop, the operator can stop everything in one click, and the pilot
produces a number the GM can show their owner. Cut and freeze before adding.

Every code task is test-first: write the failing test named in the task, then the fix.
Run `npm run typecheck` and `npm test` before each commit. One commit per task.

## Order at a glance

| # | Task | Type | Effort | Blocks |
|---|---|---|---|---|
| 0 | Start the slow outside work (ASI exports, A2P, Google, counsel) | You | 1 h, then waiting | Pilot date |
| 1 | Natural-language opt-out | Code | S | Real guests |
| 2 | Per-hotel pause switch | Code | S | Real guests |
| 3 | No-show/cancel overrides a mistaken checkout | Code | S | Real guests |
| 4 | Welcome text only on arrival day | Code | S | Real guests |
| 5 | Turn off email review requests | Code | XS | Real guests |
| 6 | Twilio auth errors retry and alert | Code | XS | Real guests |
| 7 | Require Claude for reply drafts in live mode | Code | XS | Real guests |
| 8 | Upload check shows what the import will do | Code | S | Real guests |
| 9 | Make consent approval stick when no stay matches yet | Code | S | Pilot |
| 10 | Daily "no report yet" text to the GM | Code | S | Pilot |
| 11 | Pilot metrics: textable share, upload days, taken-before-escalation | Code | M | Paid conversion |
| 12 | Per-stay cap on proactive texts | Code | S | Pilot |
| 13 | Make the landing page and README match the code | Docs | XS | Pilot |
| 14 | Freeze desktop app, extension, landing work | Decision | XS | — |
| 15 | Map real ASI exports, then a real-phone staging walk | You + code | M | Pilot |

Week 1: tasks 0–8. Week 2: tasks 9–15. Tasks 1–8 are the "before any real guest" gate.

---

## 0. Outside work (start day 1, it takes weeks)

- Ask 2–3 ASI hotels for five days of the in-house and departures CSVs, exported as they would
  each morning, plus one exported after the afternoon checkouts. Questions to answer from them:
  is there a mobile phone column, an SMS opt-in column, and what status does a guest have before
  and after checkout ("Due Out" vs "Checked Out")? Does ASI support scheduled or emailed reports?
- Submit Twilio A2P 10DLC brand and campaign (2–4+ weeks).
- Apply for Google Business Profile API access (1–3 weeks).
- Counsel questions (write them once, send them together):
  1. Does a PMS "SMS opt-in" flag captured at booking cover a post-checkout review request?
  2. Does the QR checkbox (consent text in `src/consent.ts:14`) count as written consent for the review request?
  3. Which free-text messages must count as opt-out ("please stop texting me", "don't text me")?
  4. May we email a review request to an OTA relay address (guest.booking.com, Expedia)?
  5. Is a review-request email commercial (unsubscribe link, suppression list needed)?

Done when: requests sent, exports received or chased, counsel questions sent.

## 1. Natural-language opt-out

Problem: only single keywords opt out (`src/inbound/handle.ts:16,49`). "Please stop texting me"
opens a request and the guest gets "Got it, …" back.

Change:
- `src/inbound/handle.ts`: add `isOptOutIntent(body)`: the exact keywords as today, plus phrases
  like "stop texting", "stop messaging", "don't text", "do not text", "unsubscribe me",
  "remove me", "no more texts". Keep it a conservative regex, not the model, so a model outage
  can't drop an opt-out.
- When it matches a phrase (not an exact keyword): record the opt-out, send no acknowledgement,
  still log the message, and alert the desk ("Sam Roe asked not to be texted") so a person sees it.
  Exact keywords keep today's behavior (Twilio sends the carrier confirmation).
- Open question for counsel answer #3: whether to send one plain confirmation text for phrase
  opt-outs ("You won't get more texts from Sunset Inn"). Default: send none until counsel says.

Tests (`tests/phase2.test.ts`, "inbound texts"):
- "Please stop texting me" adds to `opt_outs`, sends nothing to the guest, alerts the desk.
- A later scheduled mid-stay or review request for that phone is skipped.
- "Can you stop by with towels?" and "the noise won't stop" are not opt-outs.

## 2. Per-hotel pause switch

Problem: no way to stop guest texts without a redeploy or SQL.

Change:
- `db/migrations/008_pause.sql`: `alter table properties add column guest_texts_paused_at timestamptz, add column guest_texts_paused_by text;` (additive, per LAUNCH.md rules).
- `src/properties.ts`: add the fields to `Property`.
- `src/guest.ts` `canTextGuest`: return `{ ok: false, reason: "guest texts paused" }` when paused.
  It needs the property, so pass it in (all five call sites already have it).
- `src/outbox.ts` `dispatchOutbox`: for non-alert guest kinds, reload the property (the payload
  holds a stale copy) and leave the row `pending` with `next_attempt_at` +15 min while paused,
  so un-pausing sends nothing lost and nothing doubled. Do the same for `src/consent.ts` `attach`.
- Scheduled jobs: treat "paused" as `deferred` (+15 min) in `inStay.ts` and `requests.ts`, not
  `skipped`, so a short pause doesn't silently drop review requests. The existing 7-day
  late limit still applies.
- Staff alerts are never paused.
- UI: GM-only "Pause guest texts" / "Resume" button on `/operations` and `/hotels/:id`, red banner
  in the layout while paused, audit log entries `texts.pause` / `texts.resume`.

Tests (new `tests/pause.test.ts`):
- Paused: welcome, mid-stay, review request, follow-up, staff reply, acknowledgement all not sent;
  desk alert still sent.
- Resume: deferred review request sends once; queued acknowledgement sends once.
- Desk role gets 403 on the pause route.

## 3. No-show or cancel overrides a mistaken checkout

Problem: once a stay is `checked_out` no import can change it (`src/ingest/reconcile.ts:427-430`).
Probe: an arrivals file uploaded as "Departures" marked guests checked out, a later "No Show"
was ignored, and the guest got "thanks for staying".

Change:
- `reconcile.ts` `isRegression`: allow `checked_out` → `cancelled`/`no_show` while the stay has no
  sent review request (`review_requests` row). Still block `checked_out` → `in_house`/`reserved`.
- On that transition emit `reservation.cancelled` (already cancels pending jobs in `engine.ts:233`).
- Belt and braces in `sendReviewRequest`: skip if `checked_out_at` is null and the stay was never
  `in_house` (no `checked_in_at` from a real in-house import) and today is before departure.

Tests (`tests/ingest.test.ts`, `tests/milestones.test.ts`):
- Checked out by mistake, then "No Show": status becomes `no_show`, review job cancelled, nothing sent.
- After the review request was sent, a "No Show" row is ignored (counted as regression).
- Yesterday's in-house report after checkout still can't move a guest back (existing test stays green).

## 4. Welcome text only on arrival day

Problem: `checked_in_at` is the upload time (`reconcile.ts:455`), so the 12-hour guard in
`inStay.ts:43` never fires. With a morning upload, last night's arrivals get "welcome" at 9 AM
and "how's everything?" at 10 AM.

Change:
- `sendWelcome`: skip with "arrived before today" when the property-local date is after `arrival_date`.
- `processEvents`: don't schedule the welcome job at all in that case (keeps Operations clean).
- `consent.ts` `attach` already sends the opt-in confirmation; keep it as is.
- Update the upload page lede (`src/web/upload.ts:137`): "Upload in-house by evening for welcome
  texts; departures after checkouts for review requests" once task 15 confirms ASI's behavior.

Tests (`tests/phase2.test.ts`):
- Arrived 10/12, in-house uploaded 10/13 7:30 AM PT: no welcome, mid-stay at 10 AM only.
- Arrived today, uploaded 4 PM: welcome sent (existing test stays green).

## 5. Turn off email review requests

Problem: guests who declined SMS, and OTA relay addresses, get an email review request
(`src/reviews/requests.ts:254`; asserted in `tests/milestones.test.ts`). No unsubscribe, no suppression.

Change:
- `requests.ts`: SMS only. No SMS permission means `skipped` with the reason.
- Leave `ResendEmail` in place for desk alert emails.
- Revisit only after counsel answers #4 and #5; if turned back on, it needs an OTA-domain
  blocklist, an unsubscribe link and an `email_opt_outs` table.

Tests: change the milestones test so Marcus (declined SMS) is skipped with "no SMS consent"
and no email is sent.

## 6. Twilio auth errors retry and alert

Problem: `src/messaging.ts:39` treats every 4xx except 429 as permanent, so a bad or rotated
auth token fails every message for good.

Change:
- 401 and 403 from Twilio or Resend: throw a new `ProviderConfigError` (retryable).
- `outbox.ts`, `engine.ts`, `cases.ts`: retry it like a transient error, never mark `failed`.
- `src/alerts.ts`: critical alert "Text provider rejected our credentials" when any send in the
  last 15 min hit it; `/health/alerts` goes 503.

Tests (`tests/reliability.test.ts`): fake fetch returning 401 keeps the outbox row `pending` and
raises the critical alert; 400 with code 21211 still fails permanently.

## 7. Require Claude for reply drafts in live mode

Problem: without `ANTHROPIC_API_KEY` the template drafter answered a 4-star praise review with
"We're sorry there were problems" (seen in `npm run demo`).

Change:
- `src/runtime.ts` `validateRuntime`: require `ANTHROPIC_API_KEY` in production/live.
- `TemplateDrafter` stays for demo and tests only.
- Separately fix the template's `but|however` rule so a 4–5 star review never gets the apology
  template (it still matters in demo mode).

Tests: `tests/launch.test.ts` live mode without the key fails startup; `tests/reviews.test.ts`
4-star "loud at first but they fixed it" gets the positive template.

## 8. Upload check shows what the import will do

Problem: the check screen shows five rows. A wrong report type can mark a whole file checked out.

Change (`src/web/upload.ts` `checkPage`):
- Show the totals by resulting status: "38 checked out (review requests start 2 h after
  checkout), 4 in house, 0 cancelled".
- If the chosen report type is Departures and more than half the rows have an arrival date of
  today or later, show a warning banner and require a second "Yes, these guests have left" tick.
  Same idea for Arrivals with past departure dates.
- Show "N guests can be texted (phone and opt-in)" so low consent is visible on day one.

Tests (`tests/web.test.ts`): totals render; the warning appears for an arrivals file chosen as
Departures and the import button needs the tick.

## 9. Consent approval sticks when no stay matches yet

Problem: `approveConsent` refuses when the stay isn't imported yet (`src/consent.ts:51-52`), so
`linkPendingConsents` never finds anything. The test "links them on the next import" actually
asserts `consentsLinked` is 0.

Change:
- `approveConsent`: if no unique stay matches, record `approved_at`/`approved_by` anyway and return
  `{ status: "approved_unlinked" }`; the desk sees "Approved. It connects when today's report is uploaded."
- `linkPendingConsents` then links it on the next import (code already there).
- Fix the test to assert a real link after the import.

## 10. Daily "no report yet" text to the GM

Problem: a missed upload silently loses review requests ("checkout never reported").

Change:
- In `tick`, once per hotel per day after 11:00 local: if the in-house or departures import for
  today is missing (`sync_state` key `import:<id>:<kind>`), text the GM phone once, deduped by
  date. Not a guest text, so quiet hours don't apply, but send only between 11:00 and 20:00.

Tests (`tests/ops.test.ts`): no departures import by 11:05 sends one GM text; a second tick
sends nothing; an import before 11:00 sends nothing.

## 11. Pilot metrics a GM can show their owner

Add to `/metrics` (`src/web/metrics.ts`), per hotel:
- Textable stays: share of departed stays with a phone, consent and no opt-out.
- Upload compliance: days in the last 28 with both reports imported.
- Taken before escalation: share of issues acknowledged before `escalated_at`.
- Review requests to reviews: new Google reviews in the 7 days after requests, next to the
  same rate for the 8 weeks before launch. Label it as a comparison, not attribution.
- A print stylesheet so the page works as a one-page weekly owner report.

Tests: extend the "shows pilot metrics" test with fixed data for each number.

## 12. Per-stay cap on proactive texts

Problem: consent text says "Up to 5 messages per stay"; nothing enforces it.

Change: in `canTextGuest` for non-conversational sends, count outbound non-alert, non-staff
messages for the stay; at 5, return `{ ok: false, reason: "message limit for this stay" }`.
Staff replies to a guest who texted in are not capped.

Test: sixth proactive send is skipped with the reason.

## 13. Make the landing page and README match the code

- `src/web/landing.ts:105`: "8 PM–9 AM: no scheduled texts to guests. Replies to guests who text in can go any time."
- `:129`: "If nobody takes a complaint in 20 minutes, the GM gets a text."
- `:179`: "Guests scan it and sign up; the desk confirms it's them in one tap."
- README: delete "Staff-verified consent (backend only)", correct the health route names
  (`/healthz` vs `/health`, `/health/alerts`), and remove the email review-request fallback.

## 14. Freeze

- Desktop app, Chrome extension, `/welcome` download links, `/api/ask`: no new work. Hide the
  Ask panel and the download links behind an env flag that is off for pilots.
- The pilot uses the installed web app (LAUNCH.md already recommends it).

## 15. Real ASI data and a real-phone walk

When the exports from task 0 arrive:
- Add each hotel's mapping to `config/properties.json`; add the real (anonymized) header row and
  status values as fixtures in `tests/ingest.test.ts`.
- Decide the upload cadence from the real status behavior and update the upload page text.
- When A2P clears, run the README "Walk one stay with a real phone" checklist on staging, plus:
  "please stop texting me", pause/resume, an arrivals file chosen as Departures, a missed upload.

Done when every checklist line passes and `npm run staging:check` is all PASS.

---

## Go / no-go gates

- **Real guests (free pilot):** tasks 1–8 merged, task 0 underway, task 15's real-phone walk passed.
- **Paid pilot:** tasks 9–13 merged, 30 days of free pilot data on `/metrics`, counsel answers
  on questions 1–3, and the founder (not the desk) owning the daily upload until task 10 shows
  the desk keeps up.
