import { DateTime } from "luxon";
import type { Db } from "../db.js";
import { canTextGuest, guestVars, loadContact, renderTemplate, sendAndLog } from "../guest.js";
import type { Messenger } from "../messaging.js";
import { getProperty, nextAllowedSmsTime, PAUSE_RECHECK_MS, PAUSED, scheduledCheckout, type Property } from "../properties.js";
import type { JobOutcome } from "../reviews/requests.js";

/** Welcome text on check-in and the "how's everything?" check the morning after arrival. */

const WELCOME_MAX_LATE_HOURS = 12;

/** Morning after arrival at midstay_hour, for stays of 2+ nights, if that's before checkout. */
export function midStayTime(p: Property, arrivalDate: string, departureDate: string): DateTime | null {
  const arrival = DateTime.fromISO(arrivalDate, { zone: p.timezone });
  const departure = DateTime.fromISO(departureDate, { zone: p.timezone });
  if (departure.diff(arrival, "days").days < 2) return null;
  const at = arrival.plus({ days: 1 }).set({ hour: p.midstay_hour, minute: 0 });
  return at < scheduledCheckout(p, departureDate) ? at.toUTC() : null;
}

interface StayRow {
  property_id: string;
  status: string;
  arrival_date: string;
  departure_date: string;
  checked_in_at: Date | string | null;
}

/** Whether `at` is still the guest's arrival day, in the hotel's time zone. */
export function isArrivalDay(p: Property, arrivalDate: string, at: Date): boolean {
  return DateTime.fromJSDate(at).setZone(p.timezone).toISODate()! <= arrivalDate;
}

/** A paused hotel holds the text for later; any other refusal is final for this stay. */
export function notAllowed(reason: string, now: Date): JobOutcome {
  return reason === PAUSED
    ? { status: "deferred", runAt: new Date(now.getTime() + PAUSE_RECHECK_MS), result: reason }
    : { status: "skipped", result: reason };
}

async function load(db: Db, stayId: string) {
  const [stay] = await db.query<StayRow>(
    "select property_id, status, arrival_date::text as arrival_date, departure_date::text as departure_date, checked_in_at from stays where id = $1",
    [stayId],
  );
  if (!stay) return null;
  return { stay, property: await getProperty(db, stay.property_id), contact: (await loadContact(db, stayId))! };
}

export async function sendWelcome(db: Db, stayId: string, messenger: Messenger, nowDate: Date): Promise<JobOutcome> {
  const now = DateTime.fromJSDate(nowDate);
  const ctx = await load(db, stayId);
  if (!ctx) return { status: "skipped", result: "stay not found" };
  const { stay, property, contact } = ctx;
  if (stay.status !== "in_house") return { status: "skipped", result: `guest is ${stay.status}` };
  // checked_in_at is when the report was uploaded, not when they arrived. A welcome the morning
  // after, an hour before the mid-stay check, reads as spam.
  if (!isArrivalDay(property, stay.arrival_date, nowDate)) return { status: "skipped", result: "arrived before today" };
  if (stay.checked_in_at && now.diff(DateTime.fromJSDate(new Date(stay.checked_in_at)), "hours").hours > WELCOME_MAX_LATE_HOURS) {
    return { status: "skipped", result: "check-in reported too late for a welcome" };
  }
  const already = await db.query("select 1 from messages where stay_id = $1 and kind = 'welcome'", [stayId]);
  if (already.length) return { status: "skipped", result: "already welcomed" };

  const perm = await canTextGuest(db, contact);
  if (!perm.ok) return notAllowed(perm.reason, nowDate);
  const quiet = nextAllowedSmsTime(property, now);
  if (quiet) return { status: "deferred", runAt: quiet.toJSDate(), result: "quiet hours" };

  const body = `${renderTemplate(property.welcome_template, guestVars(property, contact))}\nReply STOP to opt out.`;
  await sendAndLog(db, messenger, { property, kind: "welcome", channel: "sms", to: perm.phone, body, stayId, at: nowDate, dedupeKey: `welcome:${stayId}` });
  return { status: "done", result: "sent welcome" };
}

export async function sendMidStay(db: Db, stayId: string, messenger: Messenger, nowDate: Date): Promise<JobOutcome> {
  const now = DateTime.fromJSDate(nowDate);
  const ctx = await load(db, stayId);
  if (!ctx) return { status: "skipped", result: "stay not found" };
  const { stay, property, contact } = ctx;
  if (stay.status !== "in_house") return { status: "skipped", result: `guest is ${stay.status}` };
  if (now > scheduledCheckout(property, stay.departure_date).minus({ hours: 3 })) {
    return { status: "skipped", result: "too close to checkout" };
  }
  // Asking "how's everything?" while their complaint is open would sound like we weren't listening.
  const open = await db.query("select 1 from recovery_cases where stay_id = $1 and resolved_at is null", [stayId]);
  if (open.length) return { status: "skipped", result: "issue already open" };

  const perm = await canTextGuest(db, contact);
  if (!perm.ok) return notAllowed(perm.reason, nowDate);
  const quiet = nextAllowedSmsTime(property, now);
  if (quiet) return { status: "deferred", runAt: quiet.toJSDate(), result: "quiet hours" };

  const body = renderTemplate(property.midstay_template, guestVars(property, contact));
  await sendAndLog(db, messenger, { property, kind: "mid_stay", channel: "sms", to: perm.phone, body, stayId, at: nowDate, dedupeKey: `mid_stay:${stayId}` });
  return { status: "done", result: "sent mid-stay check" };
}
