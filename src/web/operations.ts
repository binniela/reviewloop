import { html } from "hono/html";
import { DateTime } from "luxon";
import type { Db } from "../db.js";
import { listProperties } from "../properties.js";
import { layout, timeAgo } from "./layout.js";
import type { Alert } from "../alerts.js";
import type { TickBeat } from "../scheduler.js";

/**
 * Operations: is everything that runs on its own actually running? Report freshness, the Google
 * review sync, texts that didn't deliver or are retrying, escalations and follow-ups that hit an
 * error, and scheduled messages that failed. For the GM; the desk never needs it.
 */

export interface Freshness {
  id: string;
  name: string;
  reports: { kind: "in_house" | "departures"; at: Date | null; today: boolean }[];
  /** Today's daily reports aren't in yet (only once a hotel has imported at least once). */
  stale: boolean;
}

/** When each hotel's two daily reports were last imported, judged in the hotel's own time zone. */
export async function reportFreshness(db: Db, now: Date): Promise<Freshness[]> {
  const rows = await db.query<{ key: string; updated_at: Date }>("select key, updated_at from sync_state where key like 'import:%'");
  const at = new Map(rows.map((r) => [r.key, new Date(r.updated_at)]));
  return (await listProperties(db)).map((p) => {
    const today = DateTime.fromJSDate(now, { zone: p.timezone }).startOf("day");
    const reports = (["in_house", "departures"] as const).map((kind) => {
      const t = at.get(`import:${p.id}:${kind}`) ?? null;
      return { kind, at: t, today: !!t && DateTime.fromJSDate(t, { zone: p.timezone }) >= today };
    });
    const everImported = rows.some((r) => r.key.startsWith(`import:${p.id}:`));
    return { id: p.id, name: p.name, reports, stale: everImported && reports.some((r) => !r.today) };
  });
}

const KIND = { in_house: "In-house", departures: "Departures" } as const;
const JOB = { welcome: "Welcome text", mid_stay: "Check-in text", review_request: "Review request" } as Record<string, string>;

/** Things that need a person. Shared by this page and the sidebar badge. */
export async function problemCounts(db: Db, now: Date) {
  const [c] = await db.query<{ undelivered: number; retrying: number; escalations: number; followups: number; jobs: number; sync: number }>(
    `select
       (select count(*)::int from sms_delivery_receipts where status in ('failed','undelivered') and updated_at > $1::timestamptz - interval '24 hours') as undelivered,
       (select count(*)::int from outbound_queue where status <> 'sent' and status <> 'cancelled' and last_error is not null) as retrying,
       (select count(*)::int from recovery_cases where escalation_error is not null and resolved_at is null) as escalations,
       (select count(*)::int from recovery_cases where followup_error is not null) as followups,
       (select count(*)::int from jobs where status = 'failed' and updated_at > $1::timestamptz - interval '7 days') as jobs,
       (select count(*)::int from sync_state where key like 'reviews:%' and value like '%"ok":false%') as sync`,
    [now.toISOString()],
  );
  const counts = c ?? { undelivered: 0, retrying: 0, escalations: 0, followups: 0, jobs: 0, sync: 0 };
  return { ...counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
}

export async function operationsPage(db: Db, now: Date, alerts: Alert[], beat: TickBeat | null) {
  const fresh = await reportFreshness(db, now);
  const sync = await db.query<{ key: string; value: string; updated_at: Date }>("select key, value, updated_at from sync_state where key like 'reviews:%'");

  const undelivered = await db.query<{ body: string; status: string; error_code: string | null; updated_at: Date; guest: string | null; room: string | null; case_id: string | null; to_addr: string }>(
    `select m.body, r.status, r.error_code, r.updated_at, concat_ws(' ', s.guest_first_name, s.guest_last_name) as guest, s.room,
            m.case_id::text, m.to_addr
       from sms_delivery_receipts r join messages m on m.provider_id = r.provider_id left join stays s on s.id = m.stay_id
      where r.status in ('failed','undelivered') and r.updated_at > $1::timestamptz - interval '24 hours'
      order by r.updated_at desc limit 50`,
    [now.toISOString()],
  );
  const retrying = await db.query<{ attempts: number; next_attempt_at: Date; last_error: string; to: string; body: string; kind: string }>(
    `select attempts, next_attempt_at, last_error, payload->>'to' as "to", payload->>'body' as body, payload->>'kind' as kind
       from outbound_queue where status not in ('sent','cancelled') and last_error is not null order by next_attempt_at limit 50`,
  );
  const caseErrors = await db.query<{ id: string; summary: string; escalation_error: string | null; followup_error: string | null; guest: string; room: string | null }>(
    `select c.id::text, c.summary, case when c.resolved_at is null then c.escalation_error end as escalation_error, c.followup_error,
            concat_ws(' ', s.guest_first_name, s.guest_last_name) as guest, s.room
       from recovery_cases c join stays s on s.id = c.stay_id
      where (c.escalation_error is not null and c.resolved_at is null) or c.followup_error is not null order by c.id desc limit 50`,
  );
  const jobs = await db.query<{ kind: string; result: string | null; updated_at: Date; guest: string; room: string | null; property: string }>(
    `select j.kind, j.result, j.updated_at, concat_ws(' ', s.guest_first_name, s.guest_last_name) as guest, s.room, p.name as property
       from jobs j join stays s on s.id = j.stay_id join properties p on p.id = s.property_id
      where j.status = 'failed' and j.updated_at > $1::timestamptz - interval '7 days' order by j.updated_at desc limit 50`,
    [now.toISOString()],
  );

  const status = (ok: boolean, good: string, bad: string) => (ok ? html`<span class="tag good">${good}</span>` : html`<span class="tag err">${bad}</span>`);

  const body = html`
    ${alerts.length === 0
      ? html`<p class="all-clear"><span class="tag good">All running</span> Texts, timers, and the Google sync have no errors right now.</p>`
      : html`<div class="alerts">
          ${alerts.map(
            (a) => html`<p class="alert-line"><span class="tag ${a.severity === "critical" ? "err" : "warn"}">${a.severity === "critical" ? "Now" : "Today"}</span>
              <strong>${a.title}</strong> <span class="muted small">${a.detail}</span></p>`,
          )}
        </div>`}

    <h2>Scheduler</h2>
    <p class="${beat?.ok ? "ok-line" : ""}">
      ${beat
        ? html`${status(beat.ok, "Running", "Last run failed")} Last run ${timeAgo(new Date(beat.startedAt), now)}${beat.ok ? "" : html` <span class="muted small">${beat.error ?? ""}</span>`}`
        : html`<span class="muted">Hasn’t run yet. Something must call /cron/tick every 5 minutes.</span>`}
    </p>

    <h2>Daily reports</h2>
    <div class="table-wrap">
      <table>
        <tr><th>Hotel</th>${Object.values(KIND).map((k) => html`<th>${k}</th>`)}</tr>
        ${fresh.map(
          (f) => html`<tr>
            <td><strong>${f.name}</strong></td>
            ${f.reports.map(
              (r) => html`<td>${r.at ? html`${status(r.today, "Today", "Not today")} <span class="muted small">${timeAgo(r.at, now)}</span>` : html`<span class="muted">Never</span>`}</td>`,
            )}
          </tr>`,
        )}
      </table>
    </div>
    <p class="muted small">Welcome texts and review requests are timed from these. <a href="/upload">Upload a report</a></p>

    <h2>Google reviews</h2>
    <div class="table-wrap">
      <table>
        <tr><th>Hotel</th><th>Last sync</th><th>Status</th></tr>
        ${fresh.map((f) => {
          const row = sync.find((s) => s.key === `reviews:${f.id}`);
          let v: { ok?: boolean; error?: string; errors?: string[] } = {};
          try {
            v = row ? JSON.parse(row.value) : {};
          } catch {}
          const err = v.error ?? v.errors?.[0];
          return html`<tr>
            <td><strong>${f.name}</strong></td>
            <td>${row ? timeAgo(row.updated_at, now) : html`<span class="muted">Not yet</span>`}</td>
            <td>${row ? html`${status(v.ok !== false, "OK", "Error")} ${err ? html`<span class="muted small">${err}</span>` : ""}` : ""}</td>
          </tr>`;
        })}
      </table>
    </div>

    <h2>Texts that didn’t deliver · 24 h</h2>
    ${undelivered.length
      ? html`<div class="table-wrap"><table>
          <tr><th>Guest</th><th>Message</th><th>Carrier status</th><th>When</th></tr>
          ${undelivered.map(
            (u) => html`<tr>
              <td>${u.case_id ? html`<a href="/issues?id=${u.case_id}">${u.guest || u.to_addr}</a>` : u.guest || u.to_addr}${u.room ? html` <span class="muted">· ${u.room}</span>` : ""}</td>
              <td class="clip">${u.body}</td>
              <td><span class="tag err">${u.status}</span>${u.error_code ? html` <span class="muted small">code ${u.error_code}</span>` : ""}</td>
              <td class="muted">${timeAgo(u.updated_at, now)}</td>
            </tr>`,
          )}
        </table></div>`
      : html`<p class="ok-line">None.</p>`}

    <h2>Retrying</h2>
    ${retrying.length
      ? html`<div class="table-wrap"><table>
          <tr><th>To</th><th>Message</th><th>Tries</th><th>Next try</th><th>Last error</th></tr>
          ${retrying.map(
            (r) => html`<tr>
              <td>${r.to}</td><td class="clip">${r.body}</td><td>${r.attempts}</td>
              <td class="muted">${DateTime.fromJSDate(new Date(r.next_attempt_at)).toRelative({ base: DateTime.fromJSDate(now) })}</td>
              <td class="clip err">${r.last_error}</td>
            </tr>`,
          )}
        </table></div>`
      : html`<p class="ok-line">Nothing waiting.</p>`}

    <h2>Escalations and follow-ups</h2>
    ${caseErrors.length
      ? html`<div class="table-wrap"><table>
          <tr><th>Issue</th><th>What failed</th></tr>
          ${caseErrors.map(
            (e) => html`<tr>
              <td><a href="/issues?id=${e.id}">${e.guest}</a>${e.room ? html` <span class="muted">· ${e.room}</span>` : ""}<br /><span class="muted small">${e.summary}</span></td>
              <td class="err">${e.escalation_error ? html`GM alert: ${e.escalation_error}` : ""}${e.escalation_error && e.followup_error ? html`<br />` : ""}${e.followup_error ? html`Follow-up: ${e.followup_error}` : ""}</td>
            </tr>`,
          )}
        </table></div>`
      : html`<p class="ok-line">No errors. GM alerts and follow-ups are going out.</p>`}

    <h2>Scheduled texts that failed · 7 days</h2>
    ${jobs.length
      ? html`<div class="table-wrap"><table>
          <tr><th>Text</th><th>Guest</th><th>Why</th><th>When</th></tr>
          ${jobs.map(
            (j) => html`<tr>
              <td>${JOB[j.kind] ?? j.kind}</td><td>${j.guest}${j.room ? html` <span class="muted">· ${j.room}</span>` : ""} <span class="muted small">${j.property}</span></td>
              <td class="clip">${j.result ?? ""}</td><td class="muted">${timeAgo(j.updated_at, now)}</td>
            </tr>`,
          )}
        </table></div>`
      : html`<p class="ok-line">None.</p>`}
  `;
  return layout("Operations", body, {
    active: "/operations",
    lede: "Everything Reviewloop does on its own: reports, the Google sync, and every text and timer. If something here is red, a guest may not have heard from you.",
  });
}
