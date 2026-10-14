// Create or update properties from a JSON file: npm run properties -- config/properties.json
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { migrate, openFromEnv } from "../src/db.js";
import { normalizePhone, parseMapping } from "../src/ingest/asiReport.js";

// Load .env if present (Node 20.12+).
try {
  process.loadEnvFile();
} catch {}

const schema = z.array(
  z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string(),
    timezone: z.string().default("America/Los_Angeles"),
    checkout_time: z.string().regex(/^\d\d:\d\d$/).default("11:00"),
    review_delay_min: z.number().int().min(0).default(120),
    quiet_start: z.string().default("20:00"),
    quiet_end: z.string().default("09:00"),
    google_place_id: z.string().nullable().default(null),
    google_location: z.string().nullable().default(null),
    reply_mode: z.enum(["approval_all", "auto_high", "auto_all"]).default("auto_high"),
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
  }),
);

const file = process.argv[2];
if (!file) throw new Error("usage: npm run properties -- <file.json>");
const props = schema.parse(JSON.parse(await readFile(file, "utf8")));
const db = await openFromEnv();
await migrate(db);
for (const p of props) {
  if (p.report_mapping) parseMapping(p.report_mapping); // validate early
  for (const n of [p.sms_from, p.gm_phone, ...p.desk_phones]) {
    if (n && !normalizePhone(n)) throw new Error(`${p.id}: "${n}" is not a valid phone number`);
  }
  p.sms_from = p.sms_from ? normalizePhone(p.sms_from) : null;
  p.gm_phone = p.gm_phone ? normalizePhone(p.gm_phone) : null;
  p.desk_phones = p.desk_phones.map((n) => normalizePhone(n)!);
  const cols = [
    "id", "name", "timezone", "checkout_time", "review_delay_min", "quiet_start", "quiet_end",
    "google_place_id", "google_location", "reply_mode", "voice_notes", "signoff",
    "sms_from", "desk_phones", "desk_emails", "gm_phone", "escalation_minutes", "midstay_hour",
    ...(["request_template", "welcome_template", "midstay_template", "ack_template", "request_ack_template", "followup_template"]
      .filter((t) => (p as Record<string, unknown>)[t])),
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
  console.log(`saved ${p.id}`);
}
await db.close();
