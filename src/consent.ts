import { deferredMessenger, dispatchOutbox } from "./outbox.js";
import type { Db } from "./db.js";
import { guestVars, isOptedOut, loadContact, renderTemplate, sendAndLog } from "./guest.js";
import { normalizePhone } from "./ingest/asiReport.js";
import type { Messenger } from "./messaging.js";
import { getProperty } from "./properties.js";

/**
 * Opt-in from the check-in page (QR code at the front desk). The guest gives last name, room,
 * and phone. This creates a pending request only. Staff verify the guest and control of the
 * phone before the authenticated approval action attaches it to a current stay.
 */

export const CONSENT_TEXT =
  "I agree to receive text messages from {property_name} about my stay, including a check-in message, a check on how things are going, and a request for a review after checkout. Up to 5 messages per stay. Message and data rates may apply. Reply STOP to opt out, HELP for help.";

export type ConsentResult = { status: "linked"; stayId: string } | { status: "pending"; consentId: string } | { status: "invalid"; reason: string };

export async function recordConsent(
  db: Db,
  messenger: Messenger,
  input: { propertyId: string; lastName: string; room: string; phone: string; agreed: boolean },
  now = new Date(),
): Promise<ConsentResult> {
  if (!input.agreed) return { status: "invalid", reason: "Please tick the box to agree to texts." };
  const phone = normalizePhone(input.phone);
  if (!phone) return { status: "invalid", reason: "Please enter a valid mobile number." };
  const lastName = input.lastName.trim();
  const room = input.room.trim();
  if (!lastName || !room) return { status: "invalid", reason: "Please enter your last name and room number." };
  await getProperty(db, input.propertyId);

  // A public form proves neither room access nor control of the supplied phone. Keep it
  // pending until a staff member verifies both; never overwrite contact or clear STOP here.
  const [row] = await db.query<{ id: string }>(
    "insert into consents (property_id, phone, last_name, room, created_at) values ($1, $2, $3, $4, $5) returning id::text",
    [input.propertyId, phone, lastName, room, now.toISOString()],
  );
  return { status: "pending", consentId: row!.id };
}

/** Staff must verify the guest and phone in person before calling this authenticated action. */
export async function approveConsent(db: Db, messenger: Messenger, consentId: string, by: string, now = new Date()): Promise<ConsentResult> {
  const [c] = await db.query<{ property_id: string; phone: string; last_name: string; room: string; created_at: Date; approved_at: Date | null; stay_id: string | null }>(
    "select property_id, phone, last_name, room, created_at, approved_at, stay_id::text from consents where id = $1", [consentId],
  );
  if (!c) return { status: "invalid", reason: "Consent request not found." };
  if (c.approved_at && c.stay_id) return { status: "linked", stayId: c.stay_id };
  if (now.getTime() - new Date(c.created_at).getTime() > 2 * 86400000) return { status: "invalid", reason: "Consent request expired. Ask the guest to sign up again." };
  if (await isOptedOut(db, c.phone)) return { status: "invalid", reason: "Guest must text START from this phone before it can receive messages." };
  const stayId = await findStay(db, c.property_id, c.last_name, c.room, now);
  if (!stayId) return { status: "invalid", reason: "No unique current stay matches. Import the current report and try again." };
  await db.transaction(async (tx) => {
    await tx.query("select id from stays where id = $1 for update", [stayId]);
    await tx.query("update consents set approved_at = $2, approved_by = $3, stay_id = $4 where id = $1", [consentId, now.toISOString(), by, stayId]);
    await attach(tx, deferredMessenger, stayId, c.phone, now);
  });
  await dispatchOutbox(db, messenger, now);
  return { status: "linked", stayId };
}

/** Run after each report import: links opt-ins from the last 2 days that didn't match yet. */
export async function linkPendingConsents(db: Db, messenger: Messenger, propertyId: string, now = new Date()): Promise<number> {
  const pending = await db.query<{ id: string; phone: string; last_name: string; room: string }>(
    `select id::text, phone, last_name, room from consents
      where property_id = $1 and approved_at is not null and stay_id is null and created_at > $2::timestamptz - interval '2 days'`,
    [propertyId, now.toISOString()],
  );
  let linked = 0;
  for (const c of pending) {
    const stayId = await findStay(db, propertyId, c.last_name, c.room, now);
    if (!stayId) continue;
    await db.query("update consents set stay_id = $2 where id = $1", [c.id, stayId]);
    await attach(db, messenger, stayId, c.phone, now);
    linked++;
  }
  return linked;
}

async function findStay(db: Db, propertyId: string, lastName: string, room: string, now: Date): Promise<string | null> {
  const rows = await db.query<{ id: string }>(
    `select id::text from stays
      where property_id = $1 and lower(guest_last_name) = lower($2) and lower(room) = lower($3)
        and (status = 'in_house' or (status = 'reserved' and arrival_date = ($4::timestamptz at time zone (select timezone from properties where id = $1))::date))
      order by arrival_date desc`,
    [propertyId, lastName, room, now.toISOString()],
  );
  return rows.length === 1 ? rows[0]!.id : null;
}

async function attach(db: Db, messenger: Messenger, stayId: string, phone: string, now: Date) {
  const [already] = await db.query<{ consent_phone: string | null }>("select consent_phone from stays where id = $1", [stayId]);
  await db.query("update stays set consent_phone = $2, consented_at = $3 where id = $1", [stayId, phone, now.toISOString()]);
  if (already?.consent_phone === phone) return;
  const contact = (await loadContact(db, stayId))!;
  const property = await getProperty(db, contact.propertyId);
  // Opt-in confirmation (carriers expect one). Doubles as the welcome if we hadn't sent it.
  const welcomed = await db.query("select 1 from messages where stay_id = $1 and kind = 'welcome'", [stayId]);
  const body = welcomed.length
    ? `You're signed up for texts from ${property.name} during your stay. Reply STOP to opt out.`
    : `${renderTemplate(property.welcome_template, guestVars(property, contact))}\nReply STOP to opt out.`;
  await sendAndLog(db, messenger, { property, kind: "welcome", channel: "sms", to: phone, body, stayId, at: now });
}
