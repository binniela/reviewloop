import { DeliveryUncertainError, ProviderRejectedError } from "./messaging.js";
import type { Db } from "./db.js";
import type { Messenger, OutboundMessage } from "./messaging.js";
import { guestTextsPaused, PAUSED, type Property } from "./properties.js";

/**
 * One place for reaching guests and staff, so consent, opt-outs and the message log are
 * applied the same way everywhere.
 *
 * SMS consent: the PMS opt-in flag OR an opt-in from our check-in page. A guest who texts us
 * first may get replies to that conversation. Anyone who replied STOP gets nothing, ever, until
 * they reply START.
 */

export interface GuestContact {
  stayId: string;
  propertyId: string;
  firstName: string | null;
  lastName: string | null;
  room: string | null;
  confirmation: string;
  status: string;
  phone: string | null;
  smsConsent: boolean;
  email: string | null;
}

export async function loadContact(db: Db, stayId: string): Promise<GuestContact | null> {
  const [s] = await db.query<GuestContact>(
    `select id::text as "stayId", property_id as "propertyId", guest_first_name as "firstName",
            guest_last_name as "lastName", room, confirmation, status,
            coalesce(consent_phone, phone) as phone,
            (sms_opt_in or consented_at is not null) as "smsConsent", email
       from stays where id = $1`,
    [stayId],
  );
  return s ?? null;
}

export async function isOptedOut(db: Db, phone: string): Promise<boolean> {
  return (await db.query("select 1 from opt_outs where phone = $1", [phone])).length > 0;
}

export function renderTemplate(template: string, vars: Record<string, string | null | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

export function guestVars(property: Property, c: Pick<GuestContact, "firstName">, extra: Record<string, string> = {}) {
  return { first_name: c.firstName ?? "there", property_name: property.name, ...extra };
}

export interface SendOptions {
  property: Property;
  kind: string;
  channel: "sms" | "email";
  to: string;
  body: string;
  subject?: string;
  stayId?: string | null;
  caseId?: string | null;
  at?: Date;
  dedupeKey?: string;
  /** Correlates Twilio's signed callback with a send whose API response was lost. */
  outboxId?: string;
}

/** Sends and logs. Callers decide whether the message is allowed; see canTextGuest. */
export async function sendAndLog(db: Db, messenger: Messenger, o: SendOptions): Promise<string> {
  if (o.dedupeKey) {
    const [existing] = await db.query<{ provider_id: string }>("select provider_id from messages where dedupe_key = $1", [o.dedupeKey]);
    if (existing) return existing.provider_id;
  }
  if (messenger.deferred) {
    const [queued] = await db.query<{ id: string }>(
      "insert into outbound_queue (payload, next_attempt_at) values ($1, $2) returning id::text",
      [JSON.stringify(o), (o.at ?? new Date()).toISOString()],
    );
    return `queued:${queued!.id}`;
  }
  const msg: OutboundMessage = {
    channel: o.channel,
    to: o.to,
    body: o.body,
    subject: o.subject,
    fromName: o.property.name,
    from: o.channel === "sms" ? o.property.sms_from : undefined,
    outboxId: o.outboxId,
  };
  let providerId: string;
  try {
    ({ providerId } = await messenger.send(msg));
  } catch (error) {
    // Twilio 21610: the guest texted STOP to the carrier-level opt-out. Honor it here too.
    if (error instanceof ProviderRejectedError && error.code === 21610 && o.channel === "sms") {
      await db.query("insert into opt_outs (phone, opted_out_at) values ($1, $2) on conflict do nothing", [o.to, (o.at ?? new Date()).toISOString()]);
    }
    throw error;
  }
  try {
  await db.query(
    `insert into messages (property_id, stay_id, case_id, direction, channel, kind, from_addr, to_addr, body, provider_id, created_at, dedupe_key)
     values ($1, $2, $3, 'out', $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      o.property.id,
      o.stayId ?? null,
      o.caseId ?? null,
      o.channel,
      o.kind,
      o.channel === "sms" ? o.property.sms_from : null,
      o.to,
      o.body,
      providerId,
      (o.at ?? new Date()).toISOString(),
      o.dedupeKey ?? null,
    ],
  );
  } catch (error) {
    throw new DeliveryUncertainError(`Provider accepted ${providerId}, but message logging failed: ${(error as Error).message}`);
  }
  return providerId;
}

export type TextPermission = { ok: true; phone: string } | { ok: false; reason: string };

/**
 * Whether we may text this guest. `conversational` is for replies to a guest who texted us,
 * which doesn't need prior opt-in.
 */
export async function canTextGuest(db: Db, c: GuestContact, conversational = false): Promise<TextPermission> {
  if (!c.phone) return { ok: false, reason: "no phone" };
  if (await isOptedOut(db, c.phone)) return { ok: false, reason: "guest opted out" };
  if (!c.smsConsent && !conversational) return { ok: false, reason: "no SMS consent" };
  if (await guestTextsPaused(db, c.propertyId)) return { ok: false, reason: PAUSED };
  return { ok: true, phone: c.phone };
}

/** Texts and emails the hotel's desk contacts. Optionally includes the GM's phone. */
export async function alertStaff(
  db: Db,
  messenger: Messenger,
  property: Property,
  text: string,
  opts: { caseId?: string | null; stayId?: string | null; includeGm?: boolean; onlyGm?: boolean; at?: Date; dedupeKey?: string } = {},
): Promise<number> {
  const phones = opts.onlyGm ? [] : [...property.desk_phones];
  if ((opts.includeGm || opts.onlyGm) && property.gm_phone) phones.push(property.gm_phone);
  const emails = opts.onlyGm ? [] : property.desk_emails;
  let sent = 0;
  const failures: string[] = [];
  for (const to of new Set(phones)) {
    try {
      await sendAndLog(db, messenger, { property, kind: "alert", channel: "sms", to, body: text, ...opts, dedupeKey: opts.dedupeKey ? `${opts.dedupeKey}:sms:${to}` : undefined });
      sent++;
    } catch (err) {
      if (err instanceof DeliveryUncertainError) throw err;
      failures.push(`${to}: ${(err as Error).message}`);
    }
  }
  for (const to of emails) {
    try {
      await sendAndLog(db, messenger, {
        property,
        kind: "alert",
        channel: "email",
        to,
        body: text,
        subject: `[${property.name}] Guest needs attention`,
        ...opts,
        dedupeKey: opts.dedupeKey ? `${opts.dedupeKey}:email:${to}` : undefined,
      });
      sent++;
    } catch (err) {
      if (err instanceof DeliveryUncertainError) throw err;
      failures.push(`${to}: ${(err as Error).message}`);
    }
  }
  // An alert that reached nobody must surface, not disappear: the issues page still shows the case.
  if (sent === 0 && failures.length) throw new Error(`alert failed: ${failures.join("; ")}`);
  if (sent === 0 && !messenger.deferred) throw new Error("No staff alert recipients configured");
  return sent;
}

export function staffUrl(path: string): string {
  const base = process.env.PUBLIC_URL?.replace(/\/$/, "");
  return base ? `${base}${path}` : path;
}
