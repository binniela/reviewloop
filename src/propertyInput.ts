import { z } from "zod";
import type { Db } from "./db.js";
import { normalizePhone, parseMapping } from "./ingest/asiReport.js";

/**
 * Hotel settings as entered by people: the in-app Hotel setup page and `npm run properties`
 * both validate and save through here, so the two can't drift apart.
 */
export const propertyInput = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "Use lowercase letters, numbers and dashes"),
  name: z.string().trim().min(1, "Enter the hotel's name"),
  timezone: z.string().default("America/Los_Angeles"),
  checkout_time: z.string().regex(/^\d\d:\d\d$/, "Enter a time like 11:00").default("11:00"),
  review_delay_min: z.number().int().min(0).default(120),
  quiet_start: z.string().default("20:00"),
  quiet_end: z.string().default("09:00"),
  google_place_id: z.string().nullable().default(null),
  google_location: z.string().nullable().default(null),
  reply_mode: z.enum(["approval_all", "auto_high", "auto_all"]).default("approval_all"),
  voice_notes: z.string().default(""),
  signoff: z.string().default(""),
  request_template: z.string().optional(),
  report_mapping: z.unknown().optional(),
  sms_from: z.string().nullable().default(null),
  desk_phones: z.array(z.string()).default([]),
  desk_emails: z.array(z.string()).default([]),
  gm_phone: z.string().nullable().default(null),
  escalation_minutes: z.number().int().min(5).default(20),
  midstay_hour: z.number().int().min(7).max(20).default(10),
  welcome_template: z.string().optional(),
  midstay_template: z.string().optional(),
  ack_template: z.string().optional(),
  request_ack_template: z.string().optional(),
  followup_template: z.string().optional(),
});
export type PropertyInput = z.infer<typeof propertyInput>;

const OPTIONAL_TEMPLATES = ["request_template", "welcome_template", "midstay_template", "ack_template", "request_ack_template", "followup_template"];

/** Checks phone numbers and the report mapping, normalizes phones, and upserts the hotel. */
export async function saveProperty(db: Db, input: PropertyInput) {
  const p = { ...input };
  if (p.report_mapping) parseMapping(p.report_mapping);
  const phone = (n: string, label: string) => {
    const e164 = normalizePhone(n);
    if (!e164) throw new Error(`${label} "${n}" isn't a phone number we can text`);
    return e164;
  };
  p.sms_from = p.sms_from ? phone(p.sms_from, "Texting number") : null;
  p.gm_phone = p.gm_phone ? phone(p.gm_phone, "GM mobile") : null;
  p.desk_phones = p.desk_phones.map((n) => phone(n, "Front desk phone"));
  const cols = [
    "id", "name", "timezone", "checkout_time", "review_delay_min", "quiet_start", "quiet_end",
    "google_place_id", "google_location", "reply_mode", "voice_notes", "signoff",
    "sms_from", "desk_phones", "desk_emails", "gm_phone", "escalation_minutes", "midstay_hour",
    ...OPTIONAL_TEMPLATES.filter((t) => (p as Record<string, unknown>)[t]),
    ...(p.report_mapping ? ["report_mapping"] : []),
  ];
  const vals = cols.map((c) => {
    const v = (p as Record<string, unknown>)[c];
    return c === "report_mapping" ? JSON.stringify(v) : v;
  });
  await db.query(
    `insert into properties (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})
     on conflict (id) do update set ${cols.slice(1).map((c) => `${c} = excluded.${c}`).join(", ")}`,
    vals,
  );
  return p;
}
