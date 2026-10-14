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

- `/staff` For the GM: add and remove people, reset passwords and PINs, and register front desk PCs.
  `/audit` is the activity log: who took, texted, resolved, approved or dismissed what, and when.

## Staff sign-in

Everyone has their own account, with one of two roles:

| | Front desk | GM |
|---|---|---|
| Guest issues, Upload, Check-in QR | ✓ | ✓ |
| Review replies (approve and post), Metrics, Operations, Hotel setup, Staff, Activity log | | ✓ |

- **First start:** the `ADMIN_USER` / `ADMIN_PASSWORD` login becomes the first GM, with the same
  username and password. Anything recorded under the old shared login moves into the activity log,
  marked "Shared login". Everyone signs in once more after upgrading (old sessions don't carry over).
- **Adding people:** the GM fills in a name, role, 4-digit PIN and/or password on `/staff` and tells
  them in person. People change their own on `/account` (under their name, top right). Resetting or
  removing someone signs them out everywhere at once.
- **Shared front desk PC:** the GM signs in on that computer and clicks "Use this computer for the
  front desk" on `/staff`. From then on it opens on "Who's at the desk?": pick your name, type your
  PIN. "Switch person" (top right, or the bottom of the sidebar) hands it to the next clerk. After
  `DESK_IDLE_MINUTES` (default 15) without a click or keypress it warns for a minute, then goes back
  to the name screen. Polling for new issues doesn't count as activity. PINs work only on registered
  desk PCs, and 5 wrong tries lock that person's PIN for an hour (their password still works).
- **Scripts:** HTTP Basic checks an active staff username and password, with the same role and
  revocation rules as browser sign-in. Removing a GM also removes their Basic access. There is no
  permanent deployment-credential login fallback.
- Rotate the first GM's password before inviting staff if the old shared password was ever known
  to anyone else. Changing `ADMIN_PASSWORD` alone invalidates cookies and desk PC registrations;
  it does not change the first GM's stored password. Keep a second GM account for recovery.

Public: `/checkin/:propertyId` (opt-in page), `/webhooks/twilio/sms` (Twilio, signature-checked).
Machine: `GET /cron/tick` and `POST /api/ingest/:propertyId?kind=...` with `Authorization: Bearer $CRON_SECRET`.
Health: public `GET /health` checks database and migrations; `GET /health/alerts` uses
`Authorization: Bearer $MONITOR_TOKEN` and returns 503 for critical operational alerts.

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
session cookie backed by a sessions table (12 hours, less on a desk PC; see Staff sign-in); basic
auth still works for scripts.

**Mac and Windows builds**

```bash
cd desktop
npm install
node --experimental-require-module node_modules/electron/install.js   # Electron 44 on Node 20; not needed on Node 22+
npm run signing:check                                                  # which signing variables are missing
REVIEWLOOP_URL=https://your-app.vercel.app npm run dist               # signed, notarized dist/*.dmg (universal) and *.exe
```

`npm run dist` signs and notarizes from environment variables and refuses to build unsigned unless
`UNSIGNED=1` is set (test builds only). [desktop/SIGNING.md](desktop/SIGNING.md) lists every variable
and where it comes from. Without `REVIEWLOOP_URL` the app asks for the address on first launch.
Host the installers somewhere like GitHub Releases and set `DOWNLOAD_MAC_URL` and
`DOWNLOAD_WINDOWS_URL` so `/welcome` links to them.

**Chrome extension**: `npm run extension:zip`, then upload `dist/reviewloop-extension.zip` to the
Chrome Web Store (or load `extension/` unpacked from chrome://extensions). It asks for access only
to the one console address someone enters. [extension/STORE.md](extension/STORE.md) has the listing
text and the answers the store's privacy form asks for. Set `DOWNLOAD_CHROME_URL` to its store listing.

## Deploying to Vercel

```bash
vercel deploy        # preview
vercel deploy --prod
```

`api/index.ts` serves the app; `public/` (icons, manifest, service worker) is served by Vercel's CDN.
See [the launch plan](docs/LAUNCH.md) and [incident runbook](docs/RUNBOOK.md) for deployment and response steps.

- **No `DATABASE_URL`: demo mode.** Two sample hotels in an in-memory database, mock Google,
  messages printed, sign in with `demo` / `demo` (GM) or
  `maria` / `desk-demo` (front desk). Desk PINs: Maria 2468, Tom 1357, Raj 8080. Each serverless instance has its own copy and
  resets when it restarts. Good for showing the product; not for a hotel.
- **For real:** set `DATABASE_URL` (Supabase pooler URL), `ADMIN_PASSWORD`, `CRON_SECRET`,
  `PUBLIC_URL`, `MESSAGING_MODE=live`, and the Twilio and Google credentials. Startup refuses to
  run in production without them, and refuses `MESSAGING_MODE=live` on preview deployments.
- **Scheduler:** something has to call `GET /cron/tick` with `Authorization: Bearer $CRON_SECRET`
  every 5 minutes (escalations wait on it). See the launch checklist below for Vercel Pro vs Hobby.

Run the demo locally with `npm run dev:demo` (http://localhost:3017).

## Design choices worth knowing

**Every guest is asked for a review.** Satisfaction only changes *when* (holding while an issue
is open), never *whether*. Asking only happy guests violates Google's review policy and FTC
guidance. Conduit does filter unhappy guests out, permanently; this is the compliant version.

**Texting rules.** Marketing-style texts (welcome, mid-stay, review request) need consent: the
PMS opt-in column or a staff-verified QR check-in request. A guest who texts us first gets replies to that
conversation. STOP blocks guest texts until START. Scheduled guest texts (welcome, mid-stay,
review request, and follow-up) wait until after quiet hours, 8 PM to 9 AM local. Replies to a
guest who contacted the desk and staff alerts can be sent immediately, including overnight.

**Guest data retention.** The daily scheduler redacts names, contact details, room, message
bodies, case notes, and review-request destinations for departed or cancelled stays after
365 days by default (`PII_RETENTION_DAYS`, minimum 30). Unmatched messages are redacted on
the same schedule; unlinked check-in sign-ups are deleted after 2 days. STOP suppression
numbers remain so opt-outs continue to work. External log and backup retention must be set
separately with the hosting provider.

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

## Launch checklist (live staging)

Times are elapsed time, mostly waiting on someone else. Start the slow ones first.

### Outside setup

| Step | Hands-on | Elapsed | Notes |
|---|---|---|---|
| Twilio A2P 10DLC (brand + campaign) | 1 h | **2 to 4 weeks**, sometimes longer if rejected | Unregistered US long-code traffic is blocked (error 30034), so the real-phone walk waits on this. Upgrade the account from trial first. Campaign type "Customer Care" or "Mixed". Use the check-in page wording and its screenshot as the opt-in evidence. Toll-free verification is the alternative (1 to 3 weeks). |
| Twilio number + Messaging Service with Advanced Opt-Out | 30 min | same day | Set the HELP reply to name the hotel and give the desk phone. Reviewloop does not answer HELP itself. |
| Google Business Profile API access | 30 min | **1 to 3 weeks** | Apply with the GBP API access form from a Google Cloud project. The profile must be verified. |
| Google OAuth client + refresh token | 30 min | same day, once access is granted | Scope `business.manage`, from an account that manages every location. **Set the OAuth consent screen to "In production"**: in "Testing", refresh tokens expire after 7 days and the sync silently stops. |
| Anthropic API key | 10 min | same day | Set a monthly spend limit in the Console. |
| Postgres (Supabase) | 20 min | same day | Use the pooler URL (port 6543) in `DATABASE_URL`. Set `DATABASE_CA_CERT` to Supabase's CA if the system trust store does not verify its certificate. Remote connections fail rather than bypass certificate verification. |
| Backups | 15 min | same day | Supabase Pro ($25/mo) has daily backups (7 days); add point-in-time recovery for a hotel's live data. Free projects have none you can restore. Do one restore to a scratch project before launch. |
| Scheduler (`/cron/tick` every 5 min) | 15 min | same day | Escalation after 20 minutes needs a tick at least every 5. **Vercel Hobby only allows daily crons** and rejects the deploy otherwise. On Pro, add `"crons": [{ "path": "/cron/tick", "schedule": "*/5 * * * *" }]` to `vercel.json`. On Hobby, use Supabase `pg_cron` + `pg_net` to call the URL with `Authorization: Bearer $CRON_SECRET`. |
| Uptime alerts | 15 min | same day | Point Better Stack or UptimeRobot at `GET /healthz` every 5 min, alerting by SMS or call. It returns 503 when the database is unreachable, the scheduler hasn't finished a clean run in 15 minutes, or a staff alert is uncertain, rejected, or reported undelivered. |
| Error monitoring | 30 min | same day | Runtime errors are in Vercel's logs (1 hour on Hobby). Log drains to Sentry or Better Stack need Vercel Pro. Scheduler and send failures also show on `/operations`. |
| Vercel deployment protection | 10 min | same day | Previews sit behind Vercel Authentication. Either serve staging from a domain without protection, or enable "Protection Bypass for Automation" and give Twilio webhook URLs ending in `?x-vercel-protection-bypass=<secret>`. Signatures cover the query string, and delivery callbacks pick the secret up from `VERCEL_AUTOMATION_BYPASS_SECRET`. |

### Deploy

- [ ] `vercel link`, then set env vars (Production, or the staging environment): `DATABASE_URL`, `DATABASE_CA_CERT`, `ADMIN_PASSWORD`, `CRON_SECRET` (`openssl rand -hex 32`), `PUBLIC_URL` (the exact https URL Twilio will call), `MESSAGING_MODE=live`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `ANTHROPIC_API_KEY`. Startup refuses to run in live mode with any of them missing.
- [ ] Before deploying, run `npm run migrate` once against the target database using a direct or session-pooler `DATABASE_URL` (not the transaction pooler on port 6543). The inbox and outbound indexes build concurrently. Then restore the app's transaction-pooler URL and deploy. Requests reject pending migrations rather than building indexes while guests use the app.
- [ ] `vercel deploy --prod` (or to the staging alias).
- [ ] Load the hotel: `npm run properties -- config/properties.json` against the staging database, with `sms_from`, `desk_phones`, `gm_phone`, `google_place_id` and `google_location` filled in.
- [ ] In Twilio, set the number's "A message comes in" webhook to `{PUBLIC_URL}/webhooks/twilio/sms` (HTTP POST).
- [ ] Start the scheduler and the uptime monitor.
- [ ] `PUBLIC_URL=... CRON_SECRET=... TWILIO_AUTH_TOKEN=... npm run staging:check`. Every line must say PASS. It checks the database, scheduler heartbeat, cron auth, that unsigned and forged webhooks get 403, and that a correctly signed callback is accepted.

### Walk one stay with a real phone

Use a test guest whose stay is 2+ nights, and a desk phone and GM phone you can hold. Keep `/operations` open.

- [ ] Upload an in-house CSV with the test guest, `SMS Opt In` = N.
- [ ] Scan the QR sign from `/setup`, sign up, confirm the sign-up on Guest issues. **Welcome text arrives** (it doubles as the opt-in confirmation).
- [ ] Mid-stay text: arrives the next morning at 10 AM hotel time (or move the `mid_stay` job's `run_at` to now and tick).
- [ ] Text "The AC is broken". **Acknowledgement to the guest, alert to the desk phone.**
- [ ] Don't touch it. **GM text about 20 minutes later** (next tick after 20).
- [ ] Resolve it on Guest issues. **"Is everything better now?" about 30 minutes later.** Reply "no": issue reopens, GM alerted. Resolve again, reply "yes".
- [ ] Upload a departures CSV with the guest checked out. **Review request 2 hours later** (held while an issue is open).
- [ ] Leave a Google review from a separate account. Next tick: **it appears on `/` with Claude's draft**. Edit, approve. **Reply shows on Google.**
- [ ] Text STOP: Twilio confirms, nothing else is sent (`opt_outs` has the number). Text START. Text HELP: Twilio's HELP reply only; the desk sees a normal-urgency request, the GM is not paged.
- [ ] Failed delivery: text a landline or an unreachable number from Guest issues. **It shows under "Texts that didn't deliver"** on `/operations`.
- [ ] Simulate a staff-alert timeout after Twilio accepted the SMS: `/healthz` turns 503 until Twilio's signed status callback identifies the queued alert. If no callback comes, inspect the message in Twilio by time, sender, recipient and body, contact the desk directly, and keep the alert flagged; do not resend an uncertain alert blindly.
- [ ] Error in a scheduled job: temporarily set `GOOGLE_REFRESH_TOKEN` to a wrong value and redeploy. **`/operations` shows the Google sync error** and `/cron/tick` returns 500. Put it back.
- [ ] Late or doubled cron: pause the scheduler for 30 minutes. **`/operations` says the scheduler hasn't run, `/healthz` returns 503, the uptime monitor alerts.** Resume it; missed escalations go out once. Hit `/cron/tick` twice at the same moment: one run does the work, the other returns `"skipped"`.

### What the code guarantees (tested in `tests/launch.test.ts`)

- Unsigned, forged, or wrong-URL Twilio webhooks get 403 in every mode except explicit local development.
- A permanent provider rejection (bad number, landline, unsubscribed) is not retried and shows on `/operations`. Twilio error 21610 is recorded as an opt-out. Temporary failures retry with backoff, up to 8 tries (about four hours), then show as not sent.
- Each scheduler step runs even if another fails. Failures are recorded and counted in the sidebar badge. Overlapping ticks run once. Review drafting stops after 40 s and resumes on the next tick, inside the 60 s function limit.

## Not built yet

- Phase 3: Booking.com, Expedia, Tripadvisor (draft plus deep link), low-rating alerts
- Real ASI integration if the partner program comes through (swap the CSV adapter; everything downstream stays the same)
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

The safety migration `003_reliability.sql` runs through the explicit migration command before deployment.
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
