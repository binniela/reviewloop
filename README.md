# Reviewloop

Guest texting, service recovery, and review management for independent hotels on ASI.

- **Phase 1:** ASI report import, post-checkout review requests, Google review sync, Claude reply drafts, GM approval queue
- **Phase 2:** welcome and mid-stay texts, inbound guest texts with triage, issue alerts and GM escalation, fix follow-ups, check-in opt-in page, pilot metrics

## Quick start

Needs Node 24 (`.nvmrc`; what Vercel and CI run).

```bash
npm install
npm test          # regression suite against PGlite, no external services needed
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
| Guest texts in | Triaged. Problem: issue opened, guest gets an acknowledgement, desk is alerted. Request or uncertain text: tracked as an actionable request and forwarded to the desk. Happy: nothing. |
| 20 min, nobody on it | GM gets a text |
| Issue resolved | 30 min later: "Is everything better now?" A "no" reopens it and alerts the GM. |
| 2 h after checkout | Review request, to every guest. An open issue holds it up to 48 h after checkout, then it sends anyway. |
| Review posted | Claude drafts a reply; heuristic name matches do not authorize private stay notes. Replies wait for the GM by default; automatic posting requires an explicit property setting. |

## Staff pages

- `/issues` Guest issues: open issues on the left, the conversation on the right. Checks for new
  activity every 15 seconds and chimes on new issues, so a desk with only a landline can leave it
  open as its alert. It never reloads while someone is typing. Check-in sign-ups are confirmed here.
- `/` Review replies waiting for approval
- `/metrics` Pilot metrics: Google review count and rating against the launch baseline, plus
  weekly requests, reviews, reply time, issues caught, time to fix, mid-stay reply rate
- `/upload` Upload ASI reports (CSV)
- `/setup` Printable QR sign for each front desk. Guests scan it to opt in to texts.
- `/operations` For the GM: whether today's reports are in, the Google sync, and any text, retry,
  escalation, follow-up or scheduled message that failed. The sidebar shows a red count when something needs a person.

Public: `/checkin/:propertyId` (opt-in page), `/webhooks/twilio/sms` (Twilio, signature-checked),
`/health` (database reachable and migrations current; for uptime checks).
Machine: `GET /cron/tick` and `POST /api/ingest/:propertyId?kind=...` with `Authorization: Bearer $CRON_SECRET`;
`GET /health/alerts` with `Bearer $MONITOR_TOKEN` (503 when anything critical is wrong, the same list as the top of Operations).

## Apps: web, Mac, Windows, Chrome

One server, four ways in. The console runs on your server (Vercel or anywhere); every app opens
the same console, so the desk PC and the GM's laptop see the same issues.

| | What it adds | Where |
|---|---|---|
| Web | Product page at `/welcome`, the console behind sign-in | `src/web/` |
| Installed web app | Install from Chrome or Edge (address bar, or the button on `/welcome`). App badge with the number of issues nobody has taken, desktop notifications | `public/manifest.webmanifest`, `public/sw.js` |
| Mac and Windows | Native window, dock badge (Mac) or taskbar overlay (Windows), notifications, opens at login, Cmd/Ctrl+1–5 to switch pages, an offline screen that retries on its own | `desktop/` (Electron) |
| Chrome extension | Toolbar count of open issues (red when one is urgent), popup with counts and the newest issue, a notification for each new one | `extension/` (Manifest V3) |

All of them read `GET /api/status` (signed-in only) for counts. Sign-in is a signed, HTTP-only
session cookie (30 days); basic auth still works for scripts.

**Mac and Windows builds**

```bash
cd desktop
npm install
node --experimental-require-module node_modules/electron/install.js   # Electron 44 on Node 20; not needed on Node 22+
REVIEWLOOP_URL=https://your-app.vercel.app npm run dist               # dist/*.dmg (arm64, x64) and *.exe
```

Without `REVIEWLOOP_URL` the app asks for the address on first launch. Builds are unsigned: macOS
asks people to right-click > Open the first time, and Windows SmartScreen shows "More info > Run
anyway". Sign them (Apple Developer ID, a Windows code-signing certificate) before handing them to
hotels. Host the installers somewhere like GitHub Releases and set `DOWNLOAD_MAC_URL` and
`DOWNLOAD_WINDOWS_URL` so `/welcome` links to them.

**Chrome extension**: `npm run extension:zip`, then upload `dist/reviewloop-extension.zip` to the
Chrome Web Store (or load `extension/` unpacked from chrome://extensions). It asks for access only
to the one console address someone enters. Set `DOWNLOAD_CHROME_URL` to its store listing.

## Deploying to Vercel

```bash
vercel deploy        # preview
vercel deploy --prod
```

`api/index.ts` serves the app; `public/` (icons, manifest, service worker) is served by Vercel's CDN.

Launch checklist, Supabase setup, monitoring and backups: [docs/LAUNCH.md](docs/LAUNCH.md).
What the GM does when something breaks: [docs/RUNBOOK.md](docs/RUNBOOK.md).

- **Preview deployments with no `DATABASE_URL`, or `REVIEWLOOP_DEMO=1`: demo mode.** Two sample hotels in an in-memory database, mock Google,
  messages printed, sign in with `demo` / `demo`. Each serverless instance has its own copy and
  resets when it restarts. Good for showing the product; not for a hotel.
- **For real:** set `DATABASE_URL` (Supabase pooler URL), `ADMIN_PASSWORD`, `CRON_SECRET`,
  `PUBLIC_URL`, `MESSAGING_MODE=live`, and the Twilio and Google credentials. Startup refuses to
  run in production without them, and refuses `MESSAGING_MODE=live` on preview deployments.
- **Scheduler:** something has to call `GET /cron/tick` with `Authorization: Bearer $CRON_SECRET`
  every few minutes (escalations wait on it). Overlapping calls are safe: one runs, the other returns
  `{"skipped": true}`. Vercel Cron does this on Pro (add
  `"crons": [{ "path": "/cron/tick", "schedule": "*/5 * * * *" }]` to `vercel.json`); Hobby only
  allows daily jobs, so use Supabase `pg_cron` or any external cron there.

Run the demo locally with `npm run dev:demo` (http://localhost:3017).

## Design choices worth knowing

**Every guest is asked for a review.** Satisfaction only changes *when* (holding while an issue
is open), never *whether*. Asking only happy guests violates Google's review policy and FTC
guidance. Conduit does filter unhappy guests out, permanently; this is the compliant version.

**Texting rules.** Marketing-style texts (welcome, mid-stay, review request) need consent: the
PMS opt-in column or a staff-verified QR check-in request. A guest who texts us first gets replies to that
conversation. STOP blocks everything until START. No texts 8 PM to 9 AM local.

**Triage.** Claude (Haiku by default) labels each text with sentiment, category, urgency and a
one-line summary. Keyword rules are the fallback when there's no API key or the API fails, and unrecognized messages remain actionable requests for staff. Safety words (smoke, gas, leak, injury, police...) are always urgent,
whatever the model says. A stated problem beats polite words: "room is nice but the AC is loud"
is a complaint.

**Imports are safe to repeat.** Unchanged rows are no-ops, every event has an idempotency key,
a stale report can't move a guest backwards, and a reservation missing from a report isn't
treated as cancelled. Inbound receipt, case changes, and queued sends commit together; duplicate MessageSids cannot discard unfinished delivery work.

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

Rows that fail to parse are listed on the upload page instead of failing the file. Last import outcomes are available in `/api/operations`.

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
src/web/          staff, guest, sign-in and product pages
src/boot.ts       builds the app's dependencies; demo mode
src/demo.ts       sample hotels for demo mode
api/index.ts      Vercel entry
public/           icons, web app manifest, service worker
desktop/          Mac and Windows app (Electron)
extension/        Chrome extension
db/migrations/    schema
```


## Backend reliability and operations

The safety migration `003_reliability.sql` runs through the existing migration runner on startup.
It changes existing and new properties to `approval_all`; re-enable automatic replies only after
validating them for that hotel. Matching a public review by name/date never permits private
stay notes in a draft. Template replies do not claim a happy stay when the text describes problems.

Inbound webhook processing stores messages, case changes, and outgoing work transactionally.
The durable outbox retries failed recipients independently, with backoff; successful recipients
are not resent because a different recipient failed. Both webhooks and `/cron/tick` drain it.
Keep the scheduler running even when no guests are texting. Requests and unknown actionable
texts become `kind=request` cases with the existing reply/resolve backend; they do not count as
complaints, lower satisfaction as cases, or hold review requests. Clearly positive feedback stays
out of the work queue.

Escalations are marked successful only after a provider accepts an alert. Failed attempts retain
an error and retry after five minutes. Follow-up workers claim each send to avoid overlapping
cron deliveries. Interrupted workers and ambiguous network-send outcomes require reconciliation
with the provider before retrying: neither Twilio nor a local database transaction can guarantee
exactly-once delivery across a network failure. An accepted message is not confirmed delivery.
SMS sends include a signed `/webhooks/twilio/status` callback; duplicate/out-of-order receipts are
safe, and delivery failures remain available in the operations API.

### Staff-verified consent (backend only)

A public QR form now creates a **pending** request. Last name plus room number is not sufficient
authorization to replace a phone. Staff must verify guest identity and control of the phone in
person before approving it. There is no new consent-management UI in this change.

1. Read `GET /api/consents/pending` with the staff credentials.
2. Verify the guest and phone in person, and ensure the current stay has been imported.
3. Submit `POST /api/consents/{id}/approve` with URL-encoded `verified=1`, using staff authentication.

Approval records the actor/time and queues the confirmation. Requests expire after two days.
A web signup or staff approval cannot clear STOP: the guest must text START. Pending requests
are never silently linked to a different phone during an import. Staff approval is idempotent.

### Read-only backend endpoints

All require the same staff authentication as the application:

- `/api/operations`: outbox retries/uncertain outcomes, escalation and follow-up errors, SMS delivery
  failures, interrupted/failed jobs, and last import/review-sync outcomes.
- `/api/metrics/{propertyId}?since=2026-10-01T00:00:00Z`: stay and textable-stay denominators,
  provider-accepted messages, confirmed delivered/failed SMS, unresolved cases, guest-confirmed
  resolutions, and unmatched inbound messages. The default window is 28 days. These are
  operational measures, not causal estimates of revenue or review uplift.
- `/api/cases?before={id}`: open and closed case history.
- `/api/conversations/{stayId}?before={id}`: full conversation history, 100 messages per page.
- `/api/messages/unmatched?before={id}`: unmatched messages with no 24-hour expiry.

History APIs return newest IDs first. Use the last returned ID as `before` for the next page.
The existing UI need not expose all these endpoints yet. Mid-stay response counts use the
recorded preceding outbound message; this is conversational attribution, not proof of causality.

Real production/live mode fails startup without staff authentication, cron secret, HTTPS public
URL, a production database, and messaging/Google credentials. Unsigned inbound webhooks are
forbidden in production/live mode. Explicit isolated demo mode still uses sample data and mocks.

Live ASI mappings, Google account permissions, SMS registration/delivery, and actual hotel
operating outcomes still require pilot validation. The local regression suite does not prove them.
