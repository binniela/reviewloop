import type { Db } from "./db.js";
import { guestVars, isOptedOut, loadContact, renderTemplate, sendAndLog } from "./guest.js";
import { normalizePhone } from "./ingest/asiReport.js";
import type { Messenger } from "./messaging.js";
import { getProperty } from "./properties.js";

/**
 * Opt-in from the check-in page (QR code at the front desk). The guest gives last name, room,
 * and phone. If that matches someone in house (or arriving today) the phone is attached to the
 * stay and they get a confirmation text. If not (report not uploaded yet, typo), it's kept and
 * linked on the next report import.
 */

export const CONSENT_TEXT =
  "I agree to receive text messages from {property_name} about my stay, including a check-in message, a check on how things are going, and a request for a review after checkout. Up to 5 messages per stay. Message and data rates may apply. Reply STOP to opt out, HELP for help.";

export type ConsentResult = { status: "linked"; stayId: string } | { status: "pending" } | { status: "invalid"; reason: string };

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

  // Choosing to opt in again on paper is a clear START.
  if (await isOptedOut(db, phone)) await db.query("delete from opt_outs where phone = $1", [phone]);

  const stayId = await findStay(db, input.propertyId, lastName, room, now);
  await db.query(
    "insert into consents (property_id, phone, last_name, room, stay_id, created_at) values ($1, $2, $3, $4, $5, $6)",
    [input.propertyId, phone, lastName, room, stayId, now.toISOString()],
  );
  if (!stayId) return { status: "pending" };
  await attach(db, messenger, stayId, phone, now);
  return { status: "linked", stayId };
}

/** Run after each report import: links opt-ins from the last 2 days that didn't match yet. */
export async function linkPendingConsents(db: Db, messenger: Messenger, propertyId: string, now = new Date()): Promise<number> {
  const pending = await db.query<{ id: string; phone: string; last_name: string; room: string }>(
    `select id::text, phone, last_name, room from consents
      where property_id = $1 and stay_id is null and created_at > $2::timestamptz - interval '2 days'`,
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
        and (status = 'in_house' or (status = 'reserved' and arrival_date <= $4::date))
      order by arrival_date desc`,
    [propertyId, lastName, room, now.toISOString().slice(0, 10)],
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
  try {
    await sendAndLog(db, messenger, { property, kind: "welcome", channel: "sms", to: phone, body, stayId, at: now });
  } catch {
    // Consent is still recorded; the next milestone texts will go out normally.
  }
}
