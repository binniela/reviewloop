import { DateTime } from "luxon";
import type { Db } from "./db.js";

export type ReplyMode = "approval_all" | "auto_high" | "auto_all";

export interface Property {
  id: string;
  name: string;
  timezone: string;
  checkout_time: string;
  review_delay_min: number;
  quiet_start: string;
  quiet_end: string;
  google_place_id: string | null;
  google_location: string | null;
  reply_mode: ReplyMode;
  voice_notes: string;
  signoff: string;
  request_template: string;
  report_mapping: unknown;
  sms_from: string | null;
  desk_phones: string[];
  desk_emails: string[];
  gm_phone: string | null;
  escalation_minutes: number;
  midstay_hour: number;
  welcome_template: string;
  midstay_template: string;
  ack_template: string;
  request_ack_template: string;
  followup_template: string;
}

export async function getProperty(db: Db, id: string): Promise<Property> {
  const [p] = await db.query<Property>("select * from properties where id = $1", [id]);
  if (!p) throw new Error(`unknown property "${id}"`);
  return p;
}

export async function listProperties(db: Db): Promise<Property[]> {
  return db.query<Property>("select * from properties order by name");
}

/** The property's standard checkout time on the given local date, as a UTC instant. */
export function scheduledCheckout(p: Property, departureDate: string): DateTime {
  const [h, m] = p.checkout_time.split(":").map(Number);
  return DateTime.fromISO(departureDate, { zone: p.timezone }).set({ hour: h, minute: m }).toUTC();
}

export function googleReviewLink(placeId: string): string {
  return `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`;
}

/** If `at` falls in the property's quiet hours, the next moment texting is allowed; otherwise null. */
export function nextAllowedSmsTime(p: Property, at: DateTime): DateTime | null {
  const local = at.setZone(p.timezone);
  const toMin = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return h! * 60 + m!;
  };
  const start = toMin(p.quiet_start);
  const end = toMin(p.quiet_end);
  const cur = local.hour * 60 + local.minute;
  const quiet = start > end ? cur >= start || cur < end : cur >= start && cur < end;
  if (!quiet) return null;
  let next = local.set({ hour: Math.floor(end / 60), minute: end % 60, second: 0, millisecond: 0 });
  if (next <= local) next = next.plus({ days: 1 });
  return next.toUTC();
}
