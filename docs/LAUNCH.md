# Pilot launch plan: Vercel + Supabase

Status as of 2026-10-14. Items marked **(you)** need your account, your money, or a public deploy.

## What was measured

| Check | Result |
|---|---|
| `vercel build` (CLI 62.1.0, offline) | Builds. The installed CLI (52.2.1) crashes with `Cannot read properties of undefined (reading 'readFile')`, so update it. |
| Runtime | `nodejs24.x`. `engines: ">=22"` was silently tracking the newest Node major; now pinned `24.x`, with `.nvmrc` and CI to match. |
| Function size | ~33 MB unpacked (9 MB in the function directory plus 24 MB of traced files: PGlite's wasm/data 16.8 MB, source maps 4.3 MB, Anthropic SDK 3 MB). Limit is 250 MB. |
| Cold start, demo (PGlite) | 2.1–3.3 s init on an M-series Mac, RSS up to **773 MB**. Expect slower on Lambda, and 1024 MB memory is the minimum for demo mode. |
| Cold start, real (`pg`) | 0.6–0.8 s init with migrations current, RSS ~92 MB. Migrations now run before deployment; first-request timing is not a migration benchmark. |
| Routing | Correct. `public/` is served first (`handle: filesystem`), everything else goes to `api/index.ts`, so `/health` needed no `vercel.json` change. |
| Migrations on cold start | **Were unsafe.** Booting 3 instances at once against a database with pending migrations crashed 2 with `duplicate key … schema_migrations_pkey`. Startup now rejects pending migrations; run `npm run migrate` explicitly before deployment. |
| Tests | Run `npm run typecheck` and `npm test` on Node 24 before deployment; CI also runs a real Postgres concurrency test. |

## What changed in this branch

| File | Change |
|---|---|
| `src/db.ts` | Explicit live migrations use a session advisory lock on a direct or session-pooled connection. Existing-table indexes build concurrently; transactional DDL has a short lock timeout. RLS closes Supabase's public Data API to the anon key. `pendingMigrations()` supports the health check. Pool: max 3 per instance on Vercel, 10 s idle timeout and verified remote TLS. |
| `src/scheduler.ts` (new) | A lease in `sync_state` so only one tick runs at a time (expires after 120 s, longer than `maxDuration`), plus a heartbeat recording each tick's result and the last success. |
| `src/alerts.ts` (new) | The single list of alerts: scheduler stale (critical), GM escalations failing (critical), texts failing to send (critical), Google sync failing (warning, then critical after 6 h without a success), texts stopped mid-send, carrier-undelivered, scheduled texts failed, follow-ups failing, reports late after 11:00 hotel time (all warnings). |
| `src/app.ts` | `GET /health` (public: DB reachable, migrations current, commit). `GET /health/alerts` (bearer `MONITOR_TOKEN` or `CRON_SECRET`; 503 if anything is critical). `tick()` now uses the lease and heartbeat and records `lastOk` per hotel for Google. Bearer checks are constant-time. A silent scheduler adds to the sidebar's red count. |
| `src/web/operations.ts`, `layout.ts` | Operations shows the same alert list at the top (red **Now** = critical, **Today** = warning) and a Scheduler row. |
| `src/runtime.ts`, `src/boot.ts` | Preview deployments can't run `MESSAGING_MODE=live` and need `ADMIN_PASSWORD` when they have a database. A **production** deployment with no `DATABASE_URL` now fails to start instead of silently becoming a demo/demo sandbox; set `REVIEWLOOP_DEMO=1` on a project that is meant to be a demo. `VERCEL_ENV=production` also requires `MESSAGING_MODE=live`; before, an unset value would have printed texts instead of sending them. |
| `src/log.ts` (new) | JSON-line logs: `boot`, `tick.done`, `tick.skipped`, `tick.failed`, `google.sync_failed`, `inbound.failed`, `health.alerts`, `db.pool_error`. No phone numbers or message bodies. |
| `vercel.json` | `maxDuration` 30 → 60 (a tick does Twilio, Google and Claude calls). |
| `.github/workflows/ci.yml` (new) | Typecheck plus tests on every PR and every push to main, Node from `.nvmrc`, a Postgres 17 service for the concurrency test, and an extension packaging check. |
| `tests/ops.test.ts` (new) | 16 tests (+1 against real Postgres) for everything above. |
| `vitest.config.ts` | Timeouts 30 → 60 s: each test boots its own PGlite, and the full run timed out once on a loaded laptop. |
| `package.json`, `.nvmrc`, `.env.example`, `.vercelignore` | Node 24 pin; new env vars documented. |

## Checklist

### Blocking for the pilot

1. **Run CI on the release commit.** Include migration safety, environment guards, health, alerts, and the tick lease.
2. **(you) Vercel Pro.** Hobby is for non-commercial use only, so a paid hotel pilot needs Pro anyway, and only Pro runs
   cron every 5 minutes. Then add the cron (I haven't added it: on Hobby it would fail every deploy):
   ```json
   "crons": [{ "path": "/cron/tick", "schedule": "*/5 * * * *" }]
   ```
3. **(you) Supabase project** in the same region as the Vercel function (see "Supabase" below).
4. **(you) Production environment variables** (see "Secrets"). Keep Preview free of production secrets.
5. **(you) Uptime monitors** on `/health` and `/health/alerts`, paging *your* phone.
6. **(you) Twilio:** A2P 10DLC approved (this takes weeks), auto-recharge on, error emails on,
   each number's webhook set to `{PUBLIC_URL}/webhooks/twilio/sms`.
7. **(you) Google:** set the OAuth consent screen to **In production**. Refresh tokens from a "Testing" app
   expire after 7 days, which would look exactly like "Google disconnected" a week into the pilot.
   Then confirm one sync against the live account: the client has never run against one.
8. **(you) Backups:** Supabase Pro daily backups, plus one restore drill before go-live.
9. **(you) Smoke test after the first production deploy** (see "Go-live smoke test").
10. **Print `docs/RUNBOOK.md` for the GM** and walk them through Operations once.
11. **(you) Local tooling:** Node 24 (your Node 20.17 skips vitest's native binding, which is why
    `npm test` breaks on fresh installs) and `npm i -g vercel@latest`.

### First month

- Gate merges on CI: GitHub Pro ($4/mo) for branch protection on this private repo (see "CI").
- Log drain (Axiom or Better Stack, through the Vercel Marketplace) with an alert on `"level":"error"`. Vercel's own
  log retention is short.
- Error tracking: Sentry's free tier, `@sentry/node` in `api/index.ts`. Until then the JSON error logs carry stacks.
- Weekly encrypted `pg_dump` of your own; a second restore drill.
- Staging Supabase project for preview deployments (they're demo-only until then, which is safe).
- Google sync runs on every tick: 288 calls/day per hotel. Throttle to every 30 min if quota warnings appear.
- Review staff membership regularly and revoke accounts promptly when access ends.
- Chrome Web Store listing, unlisted (see "Clients").
- macOS and Windows signing, but only if you hand out the desktop app. For the pilot, the installed web app
  (Chrome or Edge → Install) does badges and notifications with no signing.

### Later

- Desktop auto-update (needs signing first).
- Separate Vercel projects for the demo and the pilot, then drop PGlite from the pilot bundle.
- Supabase point-in-time recovery (paid add-on) once more hotels are on it.

## Supabase setup (you)

1. New project. **Region:** the AWS region nearest the hotels, and the same one as the Vercel function. Vercel's
   default `iad1` is Washington DC, which matches Supabase **East US (North Virginia)**. For a West Coast
   pilot, choose Supabase West US (Oregon) and set Vercel Settings → Functions → Region to `pdx1`.
2. Plan: **Pro is recommended** ($25/mo: daily backups kept 7 days, no auto-pause). Free projects have no
   restorable backups.
3. **Connect** → **Transaction pooler** (port 6543) string → `DATABASE_URL` on Vercel Production.
   Keep the **Session pooler** (port 5432, IPv4) string for scripts on your laptop.
4. Optional but better: Database Settings → SSL → download the certificate and paste it into
   `DATABASE_CA_CERT`.
5. Settings → API (Data API): turn it off or remove `public` from exposed schemas. This app never
   uses it. RLS is enabled by the explicit migration command; confirm in **Advisors → Security** (no "RLS
   disabled" findings after migration).
6. Run migrations before each deploy using a direct or session-pooler connection (port 5432),
   then restore the app's transaction-pooler URL. Requests refuse a database with pending migrations.
   Rules for new migrations:
   - **Additive only** in one deploy (add tables and nullable columns). Old instances keep serving
     while new ones boot, and Vercel's Instant Rollback brings back old code on the *new* schema.
   - Renames and drops take two deploys (expand, then contract).
   - Run the explicit migration command before deploying, especially for an index or backfill:
     ```bash
     DATABASE_URL="<session pooler string>" npm run migrate
     ```

## Scheduler (recommendation)

**Vercel Cron on Pro.** You need Pro for commercial use regardless. The schedule lives in
`vercel.json` next to the code, only production is called, and Vercel sends
`Authorization: Bearer $CRON_SECRET` on its own. Vercel doesn't retry failed cron runs. That's fine every 5 minutes, and
`/health/alerts` goes critical after 15 minutes without a successful tick.

Alternatives: **Supabase `pg_cron` + `pg_net`** is free and the fallback if you stay on Hobby, but the
schedule and secret live in the database rather than the repo. An **external cron**
(cron-job.org and similar) would be one more vendor holding `CRON_SECRET`, which can also import reservations.
**Not GitHub Actions `schedule`**: runs drift by 10–30+ minutes and stop after 60 days without repo activity.

Two schedulers at once (say, while switching) is safe now. The lease runs one tick and the other returns
`{"skipped": true}`. Underneath, each worker still claims its rows (`for update skip locked`, claim columns),
so nothing double-sends even when a lease expires mid-run.

## Secrets and environments (you)

Vercel → Settings → Environment Variables. Mark every secret **Sensitive**.

| Variable | Production | Preview |
|---|---|---|
| `DATABASE_URL` | Supabase transaction pooler | **unset** (demo mode) or a *staging* project, **never** production |
| `ADMIN_PASSWORD` | strong (`openssl rand -base64 24`) | set if Preview has a database |
| `CRON_SECRET` | `openssl rand -hex 32` | unset |
| `MONITOR_TOKEN` | `openssl rand -hex 32`, given only to the uptime monitor | unset |
| `PUBLIC_URL` | `https://<your domain>` (Twilio signs this exact URL) | unset |
| `MESSAGING_MODE` | `live` | **unset** (startup refuses `live` on previews) |
| `TWILIO_*`, `GOOGLE_*`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `EMAIL_FROM` | real | unset |
| `DATABASE_CA_CERT` | optional | — |
| `REVIEWLOOP_DEMO` | unset (set `1` only on a demo project) | — |

```bash
vercel env add CRON_SECRET production
vercel env ls
```

`ADMIN_PASSWORD` protects the bootstrap administrator login. Staff accounts and sessions are managed on the Staff page; revoke an individual there when their access ends. After rotating `CRON_SECRET`, redeploy so the cron picks it up.

## Observability (you)

Monitors (Better Stack, Checkly, or any service that can send a custom header), paging your phone:

1. `GET https://<domain>/health`: expect 200, every 1–3 min. This catches the app or the database being down.
2. `GET https://<domain>/health/alerts` with header `Authorization: Bearer <MONITOR_TOKEN>`: expect
   200, every 5 min, alert after 2 failures in a row. The body says which alert fired; the GM sees the
   same text at the top of Operations.

Twilio Console → Monitor → Alerts: email on errors (30003, 30005, 30007, 30034 = A2P).
Billing: auto-recharge, because an empty balance stops every text.

Log searches in Vercel: `"msg":"tick.failed"`, `"msg":"inbound.failed"`, `"msg":"google.sync_failed"`.

## CI and previews (you)

- `.github/workflows/ci.yml` runs on every PR. On a private repo, GitHub Free counts Actions minutes against
  2,000/month; this job takes about 5 min.
- Branch protection on a private repo needs **GitHub Pro**; the API returns
  `Upgrade to GitHub Pro or make this repository public`. After upgrading:
  ```bash
  gh api -X PUT repos/binniela/reviewloop/branches/main/protection --input - <<'EOF'
  {"required_status_checks":{"strict":true,"contexts":["test"]},"enforce_admins":false,
   "required_pull_request_reviews":null,"restrictions":null,"allow_force_pushes":false,"allow_deletions":false}
  EOF
  ```
- Preview deploys: Vercel → Add New → Project → import `binniela/reviewloop`. Every PR gets a preview URL,
  demo mode by default. Keep **Deployment Protection** (Vercel Authentication) on for previews.

## Backups and restore drill (you)

Supabase Pro takes daily backups (Database → Backups). Your own copy, weekly, encrypted, never in git or CI artifacts
(it contains guest phone numbers):

```bash
brew install postgresql@17 age
pg_dump "<session pooler string>" -Fc --no-owner --no-acl -f reviewloop-$(date +%F).dump
age -p -o reviewloop-$(date +%F).dump.age reviewloop-$(date +%F).dump && rm reviewloop-$(date +%F).dump
```

Drill (before go-live, then quarterly). Time it, because that time is your recovery time:

1. Create a scratch Supabase project (Free is fine) and copy its session pooler string.
2. Restore:
   ```bash
   age -d -o restore.dump reviewloop-<date>.dump.age
   pg_restore --no-owner --no-acl -d "<scratch session pooler string>" restore.dump
   ```
3. Point a local copy at it, with texts printed rather than sent:
   ```bash
   DATABASE_URL="<scratch string>" MESSAGING_MODE=console npm start
   ```
   Then check that `curl localhost:3000/health` reports `migrations: current`, and that the stays,
   messages and open issues match production.
4. Delete the scratch project and the decrypted dump.

## Go-live smoke test (you)

```bash
curl -s https://<domain>/health
curl -s -H "Authorization: Bearer $CRON_SECRET" https://<domain>/cron/tick
curl -s -H "Authorization: Bearer $MONITOR_TOKEN" https://<domain>/health/alerts
```

Expect `ok: true` from both health checks after the tick. Then, with a test stay that uses *your* phone: upload an ASI report, receive the
welcome text, reply "the AC is broken", see the issue on `/issues`, wait 20 min for the GM escalation (to your
phone as `gm_phone` during the test), resolve it, and get the follow-up.

## Clients (you, first month or later)

**Recommendation for the pilot:** the hosted console, installed as a web app from Chrome or Edge. It
gets badges and notifications with nothing to sign. The native apps and the extension are extras.

**macOS** ($99/yr Apple Developer Program). Create a *Developer ID Application* certificate and an App
Store Connect API key, then in `desktop/package.json` → `build.mac`: remove `"identity": null`, and add
`"hardenedRuntime": true`, `"notarize": true`, and a `zip` target next to `dmg` (auto-update needs the zip). Build:
```bash
cd desktop
CSC_LINK=cert.p12 CSC_KEY_PASSWORD=… APPLE_API_KEY=AuthKey_XXXX.p8 APPLE_API_KEY_ID=XXXX APPLE_API_ISSUER=… \
REVIEWLOOP_URL=https://<domain> npm run dist:mac
spctl -a -vvv -t install dist/mac-arm64/Reviewloop.app
```
Without signing, recent macOS versions don't offer right-click > Open: people must go through System
Settings > Privacy & Security > Open Anyway.

**Windows.** SmartScreen keeps warning until the app is signed and builds reputation. Cheapest current
option: Azure Trusted Signing (about $10/mo, identity validation required), which electron-builder supports via
`win.azureSignOptions`. A cloud-HSM OV certificate costs $200–500/yr. EV certificates no longer skip SmartScreen.

**Auto-update** (after signing): add `electron-updater`, set `"publish": {"provider": "github"}`, call
`autoUpdater.checkForUpdatesAndNotify()` on launch and every few hours, and publish with
`GH_TOKEN=… npm run dist -- --publish always`. Most changes ship through Vercel anyway; the app is
a window around the console.

**Chrome Web Store** ($5 one-time). The code is ready: MV3, no remote code, 16/32/48/128 icons, narrow
permissions. The listing needs:
- A **privacy policy URL** (required: the popup shows guest issue summaries). Add a `/privacy` page.
- Data disclosures: personally identifiable information and website content, not sold, not used for anything else.
- Justifications for `storage`, `alarms`, `notifications`, and the optional host permission (the console address the user enters).
- One screenshot at 1280×800 and a 440×280 promo tile.
- **Unlisted** visibility for the pilot.

Upload with `npm run extension:zip`, then use `dist/reviewloop-extension.zip`.
