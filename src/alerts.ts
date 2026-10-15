import { DateTime } from "luxon";
import type { Db } from "./db.js";
import { lastTick, TICK_STALE_MS } from "./scheduler.js";
import { listProperties } from "./properties.js";
import { CREDENTIALS_ERROR } from "./messaging.js";
import { alertHealth, problemCounts, reportFreshness } from "./web/operations.js";

/**
 * The one list of "something is wrong". The uptime monitor reads it from /health/alerts and the GM
 * sees the same list at the top of Operations, so the page and the pager never disagree.
 * Critical: guests or the GM may not be hearing from us right now. Warning: needs a look today.
 */
export interface Alert {
  code: string;
  severity: "critical" | "warning";
  title: string;
  detail: string;
}

export interface AlertOptions {
  /** False in demo mode and local development, where nothing calls /cron/tick. */
  scheduler: boolean;
}

/** Google sync failing for this long becomes critical: replies stop being drafted. */
const GOOGLE_CRITICAL_MS = 6 * 3_600_000;
/** Daily reports are judged late only after this hour, hotel time. */
const REPORTS_DUE_HOUR = 11;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;

export async function schedulerAlert(db: Db, now: Date): Promise<Alert | null> {
  const beat = await lastTick(db);
  if (!beat?.lastOkAt) {
    return {
      code: "scheduler_stale",
      severity: "critical",
      title: "Scheduled work isn’t running",
      detail: beat?.error
        ? `Every run so far has failed: ${beat.error}`
        : "Nothing has called /cron/tick yet. Welcome texts, GM escalations, follow-ups and review requests all wait on it.",
    };
  }
  const age = now.getTime() - new Date(beat.lastOkAt).getTime();
  if (age <= TICK_STALE_MS) return null;
  return {
    code: "scheduler_stale",
    severity: "critical",
    title: "Scheduled work isn’t running",
    detail: `The scheduler hasn’t run successfully for ${minutes(age)}${beat.ok ? "" : `; the latest failed: ${beat.error ?? "unknown error"}`}. GM escalations and texts are waiting.`,
  };
}

export async function alertStatus(db: Db, now: Date, opts: AlertOptions): Promise<{ ok: boolean; alerts: Alert[] }> {
  const alerts: Alert[] = [];
  if (opts.scheduler) {
    const s = await schedulerAlert(db, now);
    if (s) alerts.push(s);
  }

  const counts = await problemCounts(db, now);
  const failedAlerts = await alertHealth(db);
  if (failedAlerts) {
    alerts.push({
      code: "staff_alert_delivery",
      severity: "critical",
      title: "Staff alerts need direct follow-up",
      detail: `${plural(failedAlerts, "staff alert")} failed or has an unknown outcome. Check Twilio and contact the desk directly.`,
    });
  }
  if (counts.escalations) {
    alerts.push({
      code: "escalations_failing",
      severity: "critical",
      title: "GM alerts are failing",
      detail: `${plural(counts.escalations, "open guest issue")} couldn’t be escalated to the GM by text. Check Operations > Escalations.`,
    });
  }
  if (counts.retrying) {
    const [last] = await db.query<{ last_error: string }>(
      "select last_error from outbound_queue where status not in ('sent','cancelled') and last_error is not null order by next_attempt_at desc limit 1",
    );
    alerts.push({
      code: "texts_failing",
      severity: "critical",
      title: "Texts are failing to send",
      detail: `${plural(counts.retrying, "text")} retrying after the provider refused them. Latest error: ${last?.last_error ?? "unknown"}`,
    });
  }
  const [uncertain] = await db.query<{ n: number }>(
    `select count(*)::int as n from outbound_queue where status = 'cancelled' and last_error is not null
       and last_error <> 'guest opted out' and locked_at > $1::timestamptz - interval '24 hours'`,
    [now.toISOString()],
  );
  if (uncertain?.n) {
    alerts.push({
      code: "texts_uncertain",
      severity: "warning",
      title: "Some texts may not have gone out",
      detail: `${plural(uncertain.n, "text")} in the last 24 h stopped mid-send. Check Twilio’s message log before resending.`,
    });
  }
  if (counts.undelivered) {
    alerts.push({
      code: "texts_undelivered",
      severity: "warning",
      title: "Texts not delivered",
      detail: `${plural(counts.undelivered, "text")} rejected by the carrier in the last 24 h.`,
    });
  }
  if (counts.jobs) {
    alerts.push({
      code: "scheduled_texts_failed",
      severity: "warning",
      title: "Scheduled texts failed",
      detail: `${plural(counts.jobs, "welcome, check-in or review-request text")} failed in the last 7 days.`,
    });
  }
  if (counts.followups) {
    alerts.push({
      code: "followups_failing",
      severity: "warning",
      title: "Follow-up texts failing",
      detail: `${plural(counts.followups, "“Is everything better now?” text")} hit an error.`,
    });
  }

  const [creds] = await db.query<{ n: number }>(
    `select ((select count(*) from outbound_queue where status = 'pending' and last_error like $1)
           + (select count(*) from jobs where status = 'pending' and result like $2))::int as n`,
    [`${CREDENTIALS_ERROR}%`, `retrying: ${CREDENTIALS_ERROR}%`],
  );
  if (creds?.n) {
    alerts.push({
      code: "provider_credentials",
      severity: "critical",
      title: "Texts can’t be sent: the text service refused our login",
      detail: `${plural(creds.n, "text")} waiting. Check the Twilio (or Resend) credentials in the hosting settings; held texts go out once they’re fixed.`,
    });
  }

  const properties = await listProperties(db);
  const paused = properties.filter((p) => p.guest_texts_paused_at);
  if (paused.length) {
    alerts.push({
      code: "guest_texts_paused",
      severity: "warning",
      title: "Guest texts are paused",
      detail: `${paused.map((p) => `${p.name} (by ${p.guest_texts_paused_by ?? "a GM"})`).join(", ")}: welcome, check-in, follow-up and review-request texts are held until you resume them on Hotel setup. Staff alerts still go out.`,
    });
  }
  const names = new Map(properties.map((p) => [p.id, p.name]));
  const syncRows = await db.query<{ key: string; value: string }>("select key, value from sync_state where key like 'reviews:%'");
  const failing: { name: string; error: string; critical: boolean }[] = [];
  for (const row of syncRows) {
    let v: { ok?: boolean; error?: string; errors?: string[]; lastOk?: string } = {};
    try {
      v = JSON.parse(row.value);
    } catch {}
    if (v.ok !== false) continue;
    const id = row.key.slice("reviews:".length);
    const since = v.lastOk ? now.getTime() - new Date(v.lastOk).getTime() : Infinity;
    failing.push({ name: names.get(id) ?? id, error: v.error ?? v.errors?.[0] ?? "unknown error", critical: since > GOOGLE_CRITICAL_MS });
  }
  if (failing.length) {
    alerts.push({
      code: "google_sync_failing",
      severity: failing.some((f) => f.critical) ? "critical" : "warning",
      title: "Google review sync failing",
      detail: failing.map((f) => `${f.name}: ${f.error}`).join("; "),
    });
  }

  const zones = new Map(properties.map((p) => [p.id, p.timezone]));
  const late = (await reportFreshness(db, now)).filter(
    (f) => f.stale && DateTime.fromJSDate(now, { zone: zones.get(f.id) ?? "UTC" }).hour >= REPORTS_DUE_HOUR,
  );
  if (late.length) {
    alerts.push({
      code: "reports_late",
      severity: "warning",
      title: "Today’s reports aren’t in",
      detail: `${late.map((f) => f.name).join(", ")}: welcome texts and review requests are timed from the ASI reports.`,
    });
  }

  return { ok: !alerts.some((a) => a.severity === "critical"), alerts };
}
