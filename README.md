# Reviewloop

Review requests, AI reply drafting, and guest-issue holds for independent hotels on ASI.
Phase 1 of the plan: ASI report ingest, the checkout review-request milestone, Google review
sync, Claude reply drafts, and a GM approval queue.

## Quick start

```bash
npm install
npm test          # 28 tests, real Postgres via PGlite, no services needed
npm run demo      # full walkthrough: reports in, texts out, reviews drafted
npm run dev       # staff UI on http://localhost:3000
```

Everything runs with no credentials: messages print to the console, Google is mocked, and
replies use templates until `ANTHROPIC_API_KEY` is set. See `.env.example`.

## How it works

```
ASI report (CSV upload or POST /api/ingest)
  -> parse + normalize (src/ingest/asiReport.ts)
  -> reconcile against stored stays, emit idempotent events (src/ingest/reconcile.ts)
  -> milestone engine schedules jobs (src/milestones/engine.ts)
  -> due jobs send review requests (src/reviews/requests.ts)

Google reviews (polled each tick)
  -> upsert, match to stay, draft with Claude (src/reviews/drafter.ts)
  -> auto-post or approval queue (src/reviews/sync.ts)
```

One scheduler pass is `GET /cron/tick` with `Authorization: Bearer $CRON_SECRET`. Run it every
5 to 15 minutes (Vercel Cron, Supabase pg_cron, or `LOCAL_TICK_SECONDS` locally).

**Ingest is safe to repeat.** Reports overlap and get re-uploaded. Unchanged rows are no-ops,
every event has an idempotency key, and a stale report can never move a guest backwards (for
example an old in-house list uploaded after checkout). A reservation missing from a report is
not treated as cancelled, because reports only cover a window.

**Review request rules**
- Sent `review_delay_min` (default 120) after the actual checkout time, or the property's
  standard checkout time if the report has none.
- Moves when the departure date changes, cancels with the reservation.
- Waits if the guest hasn't been reported checked out yet; gives up a day after departure.
- SMS only with consent (`SMS Opt In` column), otherwise email, otherwise skipped. No texts
  during quiet hours (default 8 PM to 9 AM local).
- **Every guest is asked.** An open guest issue only delays the request, up to 48 hours after
  checkout, then it sends anyway. This is deliberate: asking only happy guests violates Google's
  review policy and FTC guidance, and it's what Conduit does.

**Reply rules** (`properties.reply_mode`)
- `auto_high` (default): 4 and 5 stars post automatically, 3 and below wait for approval
- `approval_all`: everything waits
- `auto_all`: everything posts
- Any review mentioning injury, police, bed bugs, refunds, discrimination and similar always waits.
- Drafts get the stay's issue notes as private context, with instructions never to reveal
  details the guest didn't post. GM edits are fed back as voice examples.
- Replying directly on Google retires the pending draft.

## Setting up a hotel

1. Copy `config/properties.example.json`, fill in each hotel, run `npm run properties -- config/properties.json`
2. Find the Google place ID (Google's Place ID Finder) and the Business Profile location name
3. Get one real export of each ASI report and set `report_mapping` to its column names (see below)
4. Upload reports at `/upload`, or have them posted to `/api/ingest/:propertyId?kind=departures`

### ASI column mapping

ASI's export format isn't public, so the default mapping in `src/ingest/asiReport.ts` is a
guess. Per property, override any of it:

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

Rows that fail to parse are reported on the upload page instead of failing the file.

## Before going live

- [ ] Real ASI exports from a pilot hotel, mapping confirmed
- [ ] How SMS consent gets captured at check-in (registration card checkbox or front desk)
- [ ] Twilio A2P 10DLC registration approved (takes weeks, start now)
- [ ] Google OAuth app + refresh token from an account managing all 4 locations. The Google
      client is written against the Business Profile v4 reviews API but **has not been run
      against a live account yet.**
- [ ] `ADMIN_PASSWORD` and `CRON_SECRET` set; `MESSAGING_MODE=live`

## Not built yet

- Phase 2: pre-arrival, check-in, and mid-stay messages; inbound SMS webhook; sentiment scoring
- Phase 3: Booking.com, Expedia, Tripadvisor (draft plus deep link), rating dashboard, alerts
- Real ASI integration if the partner program comes through (swap the CSV adapter; events,
  milestones, and everything downstream stay the same)
- Multi-user accounts (one shared login for now)
