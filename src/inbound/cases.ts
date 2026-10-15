import { DeliveryUncertainError, ProviderRejectedError } from "../messaging.js";
import type { Db } from "../db.js";
import { alertStaff, canTextGuest, guestVars, loadContact, renderTemplate, sendAndLog, staffUrl } from "../guest.js";
import type { Messenger } from "../messaging.js";
import { getProperty, nextAllowedSmsTime, PAUSE_RECHECK_MS, PAUSED } from "../properties.js";
import { DateTime } from "luxon";
import { updateSatisfaction } from "./satisfaction.js";

/** Staff actions on issues, plus the timers that run each tick (GM escalation, follow-ups). */

const FOLLOWUP_DELAY_MIN = 30;

/** True when this call took the issue; false when someone already had it. */
export async function acknowledgeCase(db: Db, caseId: string, by: string, now = new Date()): Promise<boolean> {
  const rows = await db.query(
    "update recovery_cases set acknowledged_at = $2, acknowledged_by = $3 where id = $1 and acknowledged_at is null returning 1",
    [caseId, now.toISOString(), by],
  );
  return rows.length > 0;
}

/** True when this call resolved it; false when it was already resolved. */
export async function resolveCase(db: Db, caseId: string, resolution: string | null, by: string, now = new Date()): Promise<boolean> {
  const [c] = await db.query<{ stay_id: string }>(
    `update recovery_cases set resolved_at = $2, resolution = $3,
            acknowledged_at = coalesce(acknowledged_at, $2), acknowledged_by = coalesce(acknowledged_by, $4),
            followup_due_at = $5, followup_sent_at = null, followup_claimed_at = null, followup_error = null, guest_confirmed_at = null
      where id = $1 and resolved_at is null returning stay_id::text`,
    [caseId, now.toISOString(), resolution, by, new Date(now.getTime() + FOLLOWUP_DELAY_MIN * 60_000).toISOString()],
  );
  if (c) await updateSatisfaction(db, c.stay_id);
  return !!c;
}

/** Staff texting the guest from the issues page. Returns true when sending also took the issue. */
export async function replyToGuest(db: Db, messenger: Messenger, caseId: string, text: string, by: string, now = new Date()): Promise<boolean> {
  const body = text.trim();
  if (!body) throw new Error("message is empty");
  const [c] = await db.query<{ stay_id: string; property_id: string }>(
    "select c.stay_id::text, s.property_id from recovery_cases c join stays s on s.id = c.stay_id where c.id = $1",
    [caseId],
  );
  if (!c) throw new Error("issue not found");
  const contact = (await loadContact(db, c.stay_id))!;
  const [inbound] = await db.query<{ from_addr: string }>(
    "select from_addr from messages where case_id = $1 and direction = 'in' order by created_at desc, id desc limit 1", [caseId],
  );
  if (inbound) contact.phone = inbound.from_addr;
  const texted = !!inbound;
  const perm = await canTextGuest(db, contact, texted);
  if (!perm.ok) throw new Error(`can't text this guest: ${perm.reason}`);
  const property = await getProperty(db, c.property_id);
  await sendAndLog(db, messenger, { property, kind: "staff", channel: "sms", to: perm.phone, body, stayId: c.stay_id, caseId, at: now });
  return acknowledgeCase(db, caseId, by, now);
}

async function guestHasTexted(db: Db, stayId: string) {
  return (await db.query("select 1 from messages where stay_id = $1 and direction = 'in' limit 1", [stayId])).length > 0;
}

export interface TimerSummary {
  escalated: number;
  followupsSent: number;
  followupsSkipped: number;
  errors: string[];
}

export async function runCaseTimers(db: Db, messenger: Messenger, nowDate: Date): Promise<TimerSummary> {
  const summary: TimerSummary = { escalated: 0, followupsSent: 0, followupsSkipped: 0, errors: [] };
  const now = nowDate.toISOString();

  // Nobody at the desk responded in time: tell the GM (or re-alert the desk if there's no GM phone).
  const stale = await db.query<{ id: string; stay_id: string; property_id: string; summary: string; name: string; room: string | null; minutes: number; reopened_count: number }>(
    `select c.id::text, c.stay_id::text, s.property_id, c.summary,
            concat_ws(' ', s.guest_first_name, s.guest_last_name) as name, s.room, p.escalation_minutes as minutes, c.reopened_count
       from recovery_cases c join stays s on s.id = c.stay_id join properties p on p.id = s.property_id
      where c.resolved_at is null and c.acknowledged_at is null and c.escalated_at is null and c.alerted_at is not null
        and (c.escalation_next_attempt_at is null or c.escalation_next_attempt_at <= $1::timestamptz)
        and c.alerted_at + make_interval(mins => p.escalation_minutes) <= $1::timestamptz`,
    [now],
  );
  for (const c of stale) {
    const claimed = await db.query(
      `update recovery_cases set escalation_next_attempt_at = $2
       where id = $1 and escalated_at is null and resolved_at is null and acknowledged_at is null
         and (escalation_next_attempt_at is null or escalation_next_attempt_at <= $3) returning id`,
      [c.id, new Date(nowDate.getTime() + 5 * 60_000).toISOString(), now],
    );
    if (!claimed.length) continue;
    const property = await getProperty(db, c.property_id);
    const text = `No one has responded in ${c.minutes} min: ${c.name || "Guest"}, room ${c.room ?? "?"}: ${c.summary}\n${staffUrl("/issues")}`;
    try {
      await alertStaff(db, messenger, property, text, { caseId: c.id, stayId: c.stay_id, onlyGm: !!property.gm_phone, at: nowDate, dedupeKey: `escalation:${c.id}:${c.reopened_count}` });
      await db.query("update recovery_cases set escalated_at = $2, escalation_error = null, escalation_next_attempt_at = null where id = $1", [c.id, now]);
      summary.escalated++;
    } catch (err) {
      summary.errors.push(`escalate case ${c.id}: ${(err as Error).message}`);
      await db.query("update recovery_cases set escalation_error = $2, escalation_next_attempt_at = $3 where id = $1",
        [c.id, (err as Error).message, err instanceof DeliveryUncertainError ? "infinity" : new Date(nowDate.getTime() + 5 * 60_000).toISOString()]);
    }

  }

  // A crashed sender may have reached the provider; do not blindly resend its follow-up.
  await db.query(`update recovery_cases set followup_due_at = null,
    followup_error = 'Worker interrupted; delivery outcome unknown. Reconcile with provider.'
    where followup_claimed_at < $1::timestamptz - interval '10 minutes' and followup_sent_at is null
      and followup_due_at is not null`, [now]);

  // "Is everything better now?" after a fix.
  const due = await db.query<{ id: string; stay_id: string; property_id: string; status: string }>(
    `select c.id::text, c.stay_id::text, s.property_id, s.status
       from recovery_cases c join stays s on s.id = c.stay_id
      where c.resolved_at is not null and c.followup_sent_at is null and c.followup_due_at <= $1::timestamptz`,
    [now],
  );
  for (const c of due) {
    const skip = async (why: string) => {
      await db.query("update recovery_cases set followup_due_at = null where id = $1", [c.id]);
      summary.followupsSkipped++;
      return why;
    };
    if (c.status !== "in_house") {
      await skip("guest no longer in house");
      continue;
    }
    const property = await getProperty(db, c.property_id);
    const contact = (await loadContact(db, c.stay_id))!;
    const perm = await canTextGuest(db, contact, await guestHasTexted(db, c.stay_id));
    if (!perm.ok && perm.reason === PAUSED) {
      await db.query("update recovery_cases set followup_due_at = $2 where id = $1", [c.id, new Date(nowDate.getTime() + PAUSE_RECHECK_MS).toISOString()]);
      continue;
    }
    if (!perm.ok) {
      await skip(perm.reason);
      continue;
    }
    const quiet = nextAllowedSmsTime(property, DateTime.fromJSDate(nowDate));
    if (quiet) {
      // Don't wake them up to ask; if they're checking out by then, skip it.
      await db.query("update recovery_cases set followup_due_at = $2 where id = $1", [c.id, quiet.toISO()]);
      continue;
    }
    const claimed = await db.query(
      `update recovery_cases set followup_claimed_at = $2 where id = $1 and resolved_at is not null
        and followup_sent_at is null and followup_claimed_at is null and followup_due_at <= $2 returning id`, [c.id, now],
    );
    if (!claimed.length) continue;
    try {
      await sendAndLog(db, messenger, {
        property,
        kind: "followup",
        channel: "sms",
        to: perm.phone,
        body: renderTemplate(property.followup_template, guestVars(property, contact)),
        stayId: c.stay_id,
        caseId: c.id,
        at: nowDate,
      });
      await db.query("update recovery_cases set followup_sent_at = $2, followup_error = null where id = $1", [c.id, now]);
      summary.followupsSent++;
    } catch (err) {
      summary.errors.push(`followup case ${c.id}: ${(err as Error).message}`);
      if (err instanceof DeliveryUncertainError || err instanceof ProviderRejectedError) {
        await db.query("update recovery_cases set followup_due_at = null, followup_error = $2 where id = $1", [c.id, (err as Error).message]);
      } else {
        await db.query("update recovery_cases set followup_claimed_at = null, followup_due_at = $2, followup_error = $3 where id = $1",
          [c.id, new Date(nowDate.getTime() + 5 * 60_000).toISOString(), (err as Error).message]);
      }
    }
  }
  return summary;
}
