# Reviewloop backend and security audit

Reviewed 2026-10-14. Scope: `src/app.ts`, boot and DB code, outbound delivery and consent,
inbound handling, milestones, reviews, inbox queries, migrations, and the README. Findings
below describe code behavior; this is not a legal certification of an SMS program.

## Fixed findings

| Severity | Location | Concrete failure before the fix | Fix and evidence |
| --- | --- | --- | --- |
| High | `src/app.ts:82-103` | A malicious site could submit a staff browser form using an existing signed session and acknowledge, resolve, dismiss, or send a guest message. | Same-origin validation on browser POSTs and a session-bound CSRF token on staff forms. `tests/app.test.ts` covers cross-origin and missing-token writes. Login and public check-in use same-origin validation; Twilio and bearer-token ingest retain their own authentication. |
| High | `src/app.ts:172-175`, `src/security.ts:4-14` | The process-local check-in counter reset on every serverless instance and trusted a caller-supplied `X-Forwarded-For`. An attacker could submit unlimited pending phone records. | Atomic Postgres limits by hotel, phone, and guest identity; shared across instances. Login is limited by account in `src/app.ts:207-210`. Both are tested across two app instances. A CDN or edge limit is still advisable against distributed floods. |
| High | `src/app.ts:194-199` | `next=/\evil.example` passed the old slash check and a browser interpreted it as an external redirect after login. | Resolve the target URL and require this site's origin; regression test covers the backslash form. |
| High | `src/app.ts:68-70` | A direct production `createApp` call could set `allowUnsignedWebhooks`, bypassing Twilio authentication even though the normal boot path rejected that environment setting. | Production/live app construction now rejects it; test added. SMS and status callbacks still validate `X-Twilio-Signature` using a fixed public URL. |
| High | `src/ingest/reconcile.ts:65-77` | Two report imports could both read the same old stay, then write transitions and events based on stale state. | Lock the property row and reconcile its report in one transaction. PGlite overlap and repeat-import tests pass. |
| High | `src/reviews/requests.ts:83-99`, `src/milestones/inStay.ts:54-78` | A provider send could succeed and its message log persist, then later job bookkeeping fail. Retrying could send a second review request or mid-stay text. | Stable send dedupe keys; replay test removes the request bookkeeping row and verifies only one provider send. |
| High | `src/reviews/sync.ts:68-94` | A crash after Google accepted a reply left the draft `approved` forever, invisible to the normal pending queue. | The next successful Google sync marks an observed matching reply posted, or surfaces an older unknown outcome as failed for staff inspection. Test covers both states. |
| Medium | `src/db.ts:14-31` | Migration SQL could be applied while its ledger insert failed, leaving the live schema partly advanced with no reliable record. | Transaction plus advisory lock wraps migration and ledger updates. PGlite migration runs in the test suite. |
| Medium | `src/app.ts:595-598`, `src/retention.ts:4-44` | Names, phone numbers, message bodies, case notes, and check-in requests were retained indefinitely. | Daily redaction after 365 days by default, configurable with `PII_RETENTION_DAYS` (minimum 30); unlinked sign-ups are deleted after two days. STOP suppression numbers remain. Test checks departed guest redaction and retained opt-out. |
| Medium | `src/app.ts:140-144`, `src/inbound/classify.ts:100-130`, `src/reviews/sources.ts:53-85` | Raw provider errors could reach logs; a slow Anthropic or Google call could hold a webhook or cron pass for minutes. | Inbound logs omit raw errors; Anthropic classification has a 5-second timeout, draft generation and Google calls have 15-second timeouts. Keyword classification remains the fallback. |
| Medium | `db/migrations/005_inbox_indexes.sql:1-16` | Inbox and `/api/status` filters had no matching partial indexes. | Added partial indexes. PGlite `EXPLAIN` with `enable_seqscan=off` used `recovery_cases_open_inbox`, `recovery_cases_unacked`, and `messages_unmatched_recent`; the full inbox OR predicate used a BitmapOr of the open and resolved indexes. Empty test tables do not establish production cardinality or latency. |

## Remaining risks and decisions

| Severity | Location | Scenario and recommended fix |
| --- | --- | --- |
| High | `src/app.ts:74-77,190-193,227-245` | All staff share one username and password. A former staff member can retain access until the global password changes, and `acknowledged_by` is the shared account, not a verified person. Add per-staff identities, revocation, and server-side session records before real multi-person deployment. The 12-hour signed cookie rotates on login or password change, but logout only removes the browser's cookie; there is no per-session revocation. |
| High | `src/db.ts:14-31`, `src/boot.ts:37-39`, `db/migrations/005_inbox_indexes.sql:1-16` | Startup applies all indexes inside one transaction using regular `CREATE INDEX`. On a large live Supabase table this can hold write locks while indexes build or cause startup to time out. Build these indexes concurrently in a controlled maintenance rollout, then record the migration. This was not run against live Supabase; check lock and statement timeouts before deployment. |
| High | `src/outbox.ts:14-43`, `src/messaging.ts:30-38` | If Twilio accepts an urgent alert but the worker loses its response, the queue is cancelled as uncertain to avoid duplicate SMS. If Twilio did not accept it, no one gets the alert; the issue remains visible in the desk UI. Add a provider-side reconciliation workflow and an independent alert/monitor for cancelled urgent messages. Do not blindly retry unknown outcomes. |
| Medium | `src/retention.ts:27-32`, `src/messaging.ts:20-26` | Pending outbound payloads and hosting logs/backups can retain guest data beyond the DB redaction period; console mode prints full messages. Set host log/backup retention, keep console mode away from real guests, and add a reviewed expiry policy for pending sends. |
| Medium | `src/reviews/sync.ts:161-199` | A Google timeout after acceptance can display a failed draft. Staff must inspect Google before retrying to avoid overwriting a newer external reply. The next successful sync reconciles known replies, but an immediate manual retry can still race. Disable retry until a fresh source check or implement an explicit reconcile action. |

## Checks that did not produce a finding

- SQL: application queries inspected in scope use placeholders for input values. Interpolated SQL is static query text or migration code. Report import uses parameterized upserts. No input-derived SQL identifier was found.
- HTML: Hono `html` escapes guest and review text in the inbox, queue, toasts, and form attributes. The Ask panel uses `textContent` and DOM nodes for answer text. `raw()` uses static scripts/icons or generated QR SVG, not guest strings. The existing script-tag regression test passes.
- Twilio signature: `src/inbound/twilioSignature.ts:1-20` uses URL plus alphabetically sorted POST fields, HMAC-SHA1, Base64, and constant-time comparison, matching [Twilio's documented form webhook algorithm](https://www.twilio.com/docs/usage/security). The configured `PUBLIC_URL` must exactly match the URL Twilio calls, including any query string if one is configured.
- Duplicate webhook: `messages.provider_id` is unique; `handleInbound` locks the property, logs and creates cases plus queued work in one transaction, then dispatches after commit. A concurrent duplicate PGlite test produces one case and one set of outgoing work.
- Cron overlap: jobs and outbox rows use atomic `UPDATE ... FOR UPDATE SKIP LOCKED` claims; PGlite overlap tests sent one queued message. PGlite serializes within one embedded engine; cross-process Postgres behavior was reviewed from the SQL but not load-tested on Supabase.
- Staff race: `acknowledgeCase` uses `coalesce` so simultaneous clicks preserve the first claimant. The PGlite test permits either winner and confirms one stored claimant.
- STOP/START: inbound keywords are recorded before downstream processing; STOP adds a phone-level opt-out, START clears it, and queued guest sends recheck the opt-out. Prior consent is still required for scheduled texts after START. Twilio's own standard opt-out handling is described in its [Advanced Opt-Out guide](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out).
- Consent and quiet hours: welcome, mid-stay, review-request, and follow-up SMS check consent and quiet hours. A guest-initiated conversation can receive an immediate reply and staff alerts can go overnight. The README was corrected to say this explicitly; the earlier blanket “No texts 8 PM to 9 AM” promise did not match the code.

## Failure behavior visible to people

| Outage | Guest | Desk |
| --- | --- | --- |
| Twilio send error with a definite rejection | No SMS yet; queued work retries with backoff. | Outbound errors appear in Operations. A failed direct staff reply returns to the conversation with the draft preserved. |
| Twilio timeout or unknown acceptance | Delivery may or may not have occurred; automatic resend is stopped. | Cancelled/failed state requires reconciliation; urgent-alert gap is the remaining High risk above. |
| Anthropic slow or down | Inbound classification falls back to keyword rules after at most 5 seconds; the guest's message remains actionable. | Staff gets a case/alert based on fallback; draft generation records an error and awaits the next sync. |
| Google slow or down | Scheduled guest review request is independent of Google sync, provided the review link is configured. | Review sync records an error, existing drafts remain visible; posting failure shows on the reply queue. A 15-second request limit bounds each call. |

## Verification

`npm run typecheck` passed. `npm test -- --no-file-parallelism` passed with 97 tests before the final Google reply reconciliation change; the targeted review suite then passed with 10 tests. A later full run was interrupted after another task added `tests/launch.test.ts` to the shared checkout, so there is no final all-file pass after that change. Targeted PGlite tests cover staff claim, outbox overlap, duplicate Twilio webhooks, report re-import, overlapping status imports, send replay, retention, and interrupted Google posting. No live Twilio, Google, Anthropic, or Supabase account was accessed. External timing and multi-process claims need staging verification.
