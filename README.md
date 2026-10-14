# Reviewloop

Guest texting, service recovery, and review management for independent hotels on ASI.

- **Phase 1:** ASI report import, post-checkout review requests, Google review sync, Claude reply drafts, GM approval queue
- **Phase 2:** welcome and mid-stay texts, inbound guest texts with triage, issue alerts and GM escalation, fix follow-ups, check-in opt-in page, pilot metrics

## Quick start

Needs Node 20.12 or newer.

```bash
npm install
npm test          # 51 tests against a real Postgres engine (PGlite), no services needed
npm run demo      # one full stay: check-in, complaint, escalation, fix, review, reply
npm run dev       # staff UI on http://localhost:3000
```

Everything runs without credentials: messages print instead of sending, Google is mocked,
guest texts are triaged with keyword rules, and replies use templates. Copy `.env.example`
to `.env` to turn real services on one at a time.

## The guest journey

| When | What happens |
|---|---|
| Check-in | Welcome text (if they opted in): "text this number if you need anything" |
| Morning after arrival, 10 AM | "How's everything so far?" (2+ night stays) |
| Guest texts in | Triaged. Problem: issue opened, guest gets an acknowledgement, desk is alerted. Request: forwarded to desk. Happy: nothing. |
| 20 min, nobody on it | GM gets a text |
| Issue resolved | 30 min later: "Is everything better now?" A "no" reopens it and alerts the GM. |
| 2 h after checkout | Review request, to every guest. An open issue holds it up to 48 h after checkout, then it sends anyway. |
| Review posted | Claude drafts a reply with the stay's issue notes as private context. 4 to 5 stars auto-post; the rest wait for the GM. |

## Staff pages

- `/issues` Guest issues. Refreshes every 30 seconds and chimes on new ones, so a desk with
  only a landline can leave it open as its alert. Text the guest, mark "I'm on it", resolve.
- `/` Review replies waiting for approval
- `/metrics` Pilot metrics: Google review count and rating against the launch baseline, plus
  weekly requests, reviews, reply time, issues caught, time to fix, mid-stay reply rate
- `/upload` Upload ASI reports (CSV)
- `/setup` Printable QR sign for each front desk. Guests scan it to opt in to texts.

Public: `/checkin/:propertyId` (opt-in page), `/webhooks/twilio/sms` (Twilio, signature-checked).
Machine: `GET /cron/tick` and `POST /api/ingest/:propertyId?kind=...` with `Authorization: Bearer $CRON_SECRET`.

## Design choices worth knowing

**Every guest is asked for a review.** Satisfaction only changes *when* (holding while an issue
is open), never *whether*. Asking only happy guests violates Google's review policy and FTC
guidance. Conduit does filter unhappy guests out, permanently; this is the compliant version.

**Texting rules.** Marketing-style texts (welcome, mid-stay, review request) need consent: the
PMS opt-in column or the QR check-in page. A guest who texts us first gets replies to that
conversation. STOP blocks everything until START. No texts 8 PM to 9 AM local.

**Triage.** Claude (Haiku by default) labels each text with sentiment, category, urgency and a
one-line summary. Keyword rules are the fallback when there's no API key or the API fails, so a
complaint is never dropped. Safety words (smoke, gas, leak, injury, police...) are always urgent,
whatever the model says. A stated problem beats polite words: "room is nice but the AC is loud"
is a complaint.

**Imports are safe to repeat.** Unchanged rows are no-ops, every event has an idempotency key,
a stale report can't move a guest backwards, and a reservation missing from a report isn't
treated as cancelled. Twilio retries are deduplicated by MessageSid.

**Stay satisfaction** (-1 to 1) comes from guest text sentiment and issues (open, resolved,
reopened), with later signals weighted more. It's shown to staff and on metrics.

## Setting up a hotel

1. Copy `config/properties.example.json`, fill in each hotel, then `npm run properties -- config/properties.json`
2. Google: the place ID (Google's Place ID Finder) and Business Profile location name
3. Twilio: buy one number per hotel, set it as `sms_from`, point its incoming-message webhook to
   `{PUBLIC_URL}/webhooks/twilio/sms`
4. Set `desk_phones` (a cell at the desk, if there is one), `desk_emails`, and `gm_phone`
5. Get one real export of each ASI report and set `report_mapping` (below)
6. Print the QR sign from `/setup` for the front desk

### ASI column mapping

ASI's export format isn't public, so the default mapping in `src/ingest/asiReport.ts` is a
guess. Override any of it per property:

```json
"report_mapping": {
  "columns": {
    "confirmation": "Conf No", "fullName": "Guest", "phone": "Phone",
    "arrival": "Arr Date", "departure": "Dep Date", "status": "Status", "room": "Rm"
  },
  "dateFormats": ["MM/dd/yyyy"],
  "statusMap": { "in house": "in_house", "c/o": "checked_out", "cxl": "cancelled" }
}
```

Rows that fail to parse are listed on the upload page instead of failing the file.

## Before going live

- [ ] Real ASI exports from a pilot hotel, mapping confirmed
- [ ] Where alerts go at each hotel (desk cell, GM, email, or the issues page left open) and who covers overnight
- [ ] Front desk routine for handing out the QR code at check-in
- [ ] Twilio A2P 10DLC registration approved (takes weeks, start now). The opt-in wording on
      the check-in page is written for it; have it reviewed.
- [ ] Google OAuth app + refresh token from an account managing all 4 locations. The Google
      client follows the Business Profile v4 reviews API but **hasn't run against a live account yet.**
- [ ] `ADMIN_PASSWORD`, `CRON_SECRET`, `PUBLIC_URL` set; `MESSAGING_MODE=live`

## Not built yet

- Phase 3: Booking.com, Expedia, Tripadvisor (draft plus deep link), low-rating alerts
- Real ASI integration if the partner program comes through (swap the CSV adapter; everything downstream stays the same)
- Individual staff logins (one shared login for now; the name typed into actions is not verified)
- Pre-arrival message (hotels rarely need one; easy to add as another milestone)

## Code map

```
src/ingest/       ASI CSV parsing, reconcile into stays + events
src/milestones/   job scheduling and the welcome / mid-stay senders
src/reviews/      review requests, Google sync, Claude drafting, approval rules
src/inbound/      Twilio webhook handling, triage, issues, escalation, follow-ups, satisfaction
src/consent.ts    check-in opt-in
src/guest.ts      consent and opt-out checks, message log, staff alerts
src/web/          staff and guest pages
db/migrations/    schema
```
