import { html } from "hono/html";
import type { Db } from "../db.js";
import { listProperties } from "../properties.js";
import { layout, statBox } from "./layout.js";

/** Pilot proof: Google totals against the launch baseline, plus weekly activity per hotel. */

interface WeekRow {
  week: string;
  requests: number;
  reviews: number;
  avg_new: number | null;
  replied: number;
  median_reply_h: number | null;
  issues: number;
  from_texts: number;
  resolved: number;
  median_fix_min: number | null;
  reopened: number;
  midstay: number;
  midstay_replies: number;
}

export async function weeklyMetrics(db: Db, propertyId: string, now: Date, weeks = 8): Promise<WeekRow[]> {
  return db.query<WeekRow>(
    `with w as (
       select generate_series(date_trunc('week', $2::timestamptz) - make_interval(weeks => $3 - 1),
                              date_trunc('week', $2::timestamptz), interval '1 week') as start
     )
     select to_char(w.start, 'Mon DD') as week,
       (select count(*)::int from review_requests rr join stays s on s.id = rr.stay_id
         where s.property_id = $1 and rr.sent_at >= w.start and rr.sent_at < w.start + interval '1 week') as requests,
       (select count(*)::int from reviews r where r.property_id = $1 and r.reviewed_at >= w.start and r.reviewed_at < w.start + interval '1 week') as reviews,
       (select round(avg(rating)::numeric, 2)::float from reviews r
         where r.property_id = $1 and r.reviewed_at >= w.start and r.reviewed_at < w.start + interval '1 week') as avg_new,
       (select count(*)::int from reviews r join reply_drafts d on d.review_id = r.id
         where r.property_id = $1 and d.status = 'posted' and r.reviewed_at >= w.start and r.reviewed_at < w.start + interval '1 week') as replied,
       (select round((percentile_cont(0.5) within group (order by extract(epoch from d.posted_at - r.reviewed_at) / 3600))::numeric, 1)::float
          from reviews r join reply_drafts d on d.review_id = r.id
         where r.property_id = $1 and d.status = 'posted' and r.reviewed_at >= w.start and r.reviewed_at < w.start + interval '1 week') as median_reply_h,
       (select count(*)::int from recovery_cases c join stays s on s.id = c.stay_id
         where s.property_id = $1 and c.opened_at >= w.start and c.opened_at < w.start + interval '1 week') as issues,
       (select count(*)::int from recovery_cases c join stays s on s.id = c.stay_id
         where s.property_id = $1 and c.source = 'guest_text' and c.opened_at >= w.start and c.opened_at < w.start + interval '1 week') as from_texts,
       (select count(*)::int from recovery_cases c join stays s on s.id = c.stay_id
         where s.property_id = $1 and c.resolved_at is not null and c.opened_at >= w.start and c.opened_at < w.start + interval '1 week') as resolved,
       (select round((percentile_cont(0.5) within group (order by extract(epoch from c.resolved_at - c.opened_at) / 60))::numeric)::float
          from recovery_cases c join stays s on s.id = c.stay_id
         where s.property_id = $1 and c.resolved_at is not null and c.opened_at >= w.start and c.opened_at < w.start + interval '1 week') as median_fix_min,
       (select count(*)::int from recovery_cases c join stays s on s.id = c.stay_id
         where s.property_id = $1 and c.reopened_count > 0 and c.opened_at >= w.start and c.opened_at < w.start + interval '1 week') as reopened,
       (select count(*)::int from messages m where m.property_id = $1 and m.kind = 'mid_stay'
         and m.created_at >= w.start and m.created_at < w.start + interval '1 week') as midstay,
       (select count(*)::int from messages m where m.property_id = $1 and m.kind = 'mid_stay'
         and m.created_at >= w.start and m.created_at < w.start + interval '1 week'
         and exists (select 1 from messages i where i.stay_id = m.stay_id and i.direction = 'in'
                       and i.created_at > m.created_at and i.created_at < m.created_at + interval '24 hours')) as midstay_replies
     from w order by w.start desc`,
    [propertyId, now.toISOString(), weeks],
  );
}

export async function metricsPage(db: Db, now: Date) {
  const properties = await listProperties(db);
  const sections = [];
  for (const p of properties) {
    const snaps = await db.query<{ day: string; review_count: number; avg_rating: number | null }>(
      "select day::text, review_count, avg_rating from review_snapshots where property_id = $1 and source = 'google' order by day",
      [p.id],
    );
    const first = snaps[0];
    const last = snaps.at(-1);
    const weeks = await weeklyMetrics(db, p.id, now);
    const sum = (k: keyof WeekRow) => weeks.reduce((a, w) => a + Number(w[k] ?? 0), 0);
    const delta = (a: number | null | undefined, b: number | null | undefined, digits = 0) => {
      if (a == null || b == null) return "";
      const d = Number((b - a).toFixed(digits));
      return d === 0 ? " (no change)" : ` (${d > 0 ? "+" : ""}${d.toFixed(digits)})`;
    };
    sections.push(html`
      <h2>${p.name}</h2>
      <div class="stats">
        ${statBox(
          first ? `Google reviews · ${first.review_count} at start${delta(first.review_count, last?.review_count)}` : "Google reviews · no baseline yet",
          last ? String(last.review_count) : "?",
        )}
        ${statBox(
          first ? `Google rating · ${first.avg_rating ?? "?"} at start${delta(first.avg_rating, last?.avg_rating, 2)}` : "Google rating",
          last?.avg_rating != null ? last.avg_rating.toFixed(2) : "?",
        )}
        ${statBox("Review requests, 8 weeks", String(sum("requests")))} ${statBox("Issues caught in stay, 8 weeks", String(sum("issues")))}
      </div>
      ${first ? html`<p class="muted">Baseline taken ${first.day}.</p>` : ""}
      <div class="table-wrap">
        <table>
          <tr>
            <th>Week of</th><th>Requests</th><th>New reviews</th><th>Avg new</th><th>Replied</th><th>Reply time</th>
            <th>Issues</th><th>From texts</th><th>Fixed</th><th>Time to fix</th><th>Reopened</th><th>Mid-stay sent</th><th>Replied to mid-stay</th>
          </tr>
          ${weeks.map(
            (w) => html`<tr>
              <td>${w.week}</td><td>${w.requests}</td><td>${w.reviews}</td><td>${w.avg_new ?? ""}</td><td>${w.replied}</td>
              <td>${w.median_reply_h != null ? `${w.median_reply_h} h` : ""}</td><td>${w.issues}</td><td>${w.from_texts}</td><td>${w.resolved}</td>
              <td>${w.median_fix_min != null ? `${w.median_fix_min} min` : ""}</td><td>${w.reopened}</td><td>${w.midstay}</td>
              <td>${w.midstay ? `${Math.round((100 * w.midstay_replies) / w.midstay)}%` : ""}</td>
            </tr>`,
          )}
        </table>
      </div>
    `);
  }
  return layout(
    "Pilot metrics",
    html`<p class="muted">
        Google totals come from the platform each sync; the first day recorded is the baseline. Times are medians. Reply time is
        from review posted to reply posted.
      </p>
      ${sections}`,
  );
}
