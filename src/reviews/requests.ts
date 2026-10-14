import { DateTime } from "luxon";
import type { Db } from "../db.js";
import { canTextGuest, loadContact, renderTemplate, sendAndLog } from "../guest.js";
import type { Messenger } from "../messaging.js";
import { getProperty, googleReviewLink, nextAllowedSmsTime, scheduledCheckout } from "../properties.js";

/**
 * Sends the post-checkout review request.
 *
 * Every guest who checked out is asked. Guest satisfaction never decides WHO is asked, only
 * WHEN: if a recovery case is still open, the request waits (up to RECOVERY_HOLD_HOURS after
 * checkout) so staff can make it right first, then goes out regardless. Selectively asking only
 * happy guests ("review gating") violates Google's review policy and FTC guidance.
 */

export const RECOVERY_HOLD_HOURS = 48;
const MAX_LATE_DAYS = 7; // a checkout we learn about this late gets no request
const RECHECK_MINUTES = 60;

export type JobOutcome =
  | { status: "done" | "skipped"; result: string }
  | { status: "deferred"; runAt: Date; result: string };

interface StayRow {
  property_id: string;
  status: string;
  departure_date: string;
  checked_out_at: Date | string | null;
}

export async function sendReviewRequest(db: Db, stayId: string, messenger: Messenger, nowDate: Date): Promise<JobOutcome> {
  const now = DateTime.fromJSDate(nowDate).toUTC();
  const [stay] = await db.query<StayRow>(
    `select property_id, status, departure_date::text as departure_date, checked_out_at
       from stays where id = $1`,
    [stayId],
  );
  if (!stay) return { status: "skipped", result: "stay not found" };
  const property = await getProperty(db, stay.property_id);

  const already = await db.query("select 1 from review_requests where stay_id = $1", [stayId]);
  if (already.length) return { status: "skipped", result: "already sent" };

  if (stay.status !== "checked_out") {
    if (stay.status === "cancelled" || stay.status === "no_show") return { status: "skipped", result: stay.status };
    const today = now.setZone(property.timezone).toISODate()!;
    const lastDay = DateTime.fromISO(stay.departure_date).plus({ days: 1 }).toISODate()!;
    if (today > lastDay) return { status: "skipped", result: "checkout never reported" };
    // Late checkout, or today's departures report hasn't been ingested yet.
    return { status: "deferred", runAt: now.plus({ minutes: RECHECK_MINUTES }).toJSDate(), result: "waiting for checkout" };
  }

  const checkout = stay.checked_out_at
    ? DateTime.fromJSDate(new Date(stay.checked_out_at)).toUTC()
    : scheduledCheckout(property, stay.departure_date);
  if (now.diff(checkout, "days").days > MAX_LATE_DAYS) return { status: "skipped", result: "too long after checkout" };

  const [openCase] = await db.query("select id from recovery_cases where stay_id = $1 and resolved_at is null", [stayId]);
  const holdUntil = checkout.plus({ hours: RECOVERY_HOLD_HOURS });
  if (openCase && now < holdUntil) {
    const next = DateTime.min(now.plus({ minutes: RECHECK_MINUTES }), holdUntil);
    return { status: "deferred", runAt: next.toJSDate(), result: "recovery case open" };
  }

  if (!property.google_place_id) return { status: "skipped", result: "property has no Google place ID" };

  const contact = (await loadContact(db, stayId))!;
  const sms = await canTextGuest(db, contact);
  const channel = sms.ok ? "sms" : contact.email ? "email" : null;
  if (!channel) return { status: "skipped", result: sms.ok ? "no consented contact" : `no consented contact (${sms.reason})` };

  if (channel === "sms") {
    const allowed = nextAllowedSmsTime(property, now);
    if (allowed) return { status: "deferred", runAt: allowed.toJSDate(), result: "quiet hours" };
  }

  const body = renderTemplate(property.request_template, {
    first_name: contact.firstName ?? "there",
    property_name: property.name,
    review_link: googleReviewLink(property.google_place_id),
  });
  const to = sms.ok ? sms.phone : contact.email!;
  const providerId = await sendAndLog(db, messenger, {
    property,
    kind: "review_request",
    channel,
    to,
    body: channel === "sms" ? `${body}\nReply STOP to opt out.` : body,
    subject: channel === "email" ? `How was your stay at ${property.name}?` : undefined,
    stayId,
    at: now.toJSDate(),
  });

  await db.query(
    `insert into review_requests (stay_id, channel, destination, body, provider_id, sent_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [stayId, channel, to, body, providerId, now.toISO()],
  );
  const note = openCase ? " after recovery hold" : "";
  return { status: "done", result: `sent by ${channel}${note}` };
}
