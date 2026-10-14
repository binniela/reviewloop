import type { Db } from "../db.js";
import { alertStaff, guestVars, loadContact, renderTemplate, sendAndLog, staffUrl } from "../guest.js";
import { normalizePhone } from "../ingest/asiReport.js";
import type { Messenger } from "../messaging.js";
import { listProperties, type Property } from "../properties.js";
import { isComplaint, isRequest, type Classification, type Classifier } from "./classify.js";
import { updateSatisfaction } from "./satisfaction.js";

/**
 * Handles one inbound guest text: opt-out keywords, matching to a stay, classification,
 * and what happens next (new issue + acknowledgement + desk alert, request forwarded,
 * reopened issue, or nothing for "all good, thanks").
 */

const STOP = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "optout", "revoke"]);
const START = new Set(["start", "unstop", "yes"]);

export interface InboundSms {
  from: string;
  to: string;
  body: string;
  providerId: string; // Twilio MessageSid
}

export interface InboundDeps {
  messenger: Messenger;
  classifier: Classifier;
  now?: () => Date;
}

export type InboundOutcome =
  | { action: "duplicate" }
  | { action: "opted_out" | "opted_in" }
  | { action: "unknown_property" }
  | { action: "no_action"; classification: Classification }
  | { action: "case_opened" | "case_updated" | "case_reopened"; caseId: string; classification: Classification }
  | { action: "request_forwarded" | "unmatched_forwarded"; classification: Classification };

export async function handleInbound(db: Db, deps: InboundDeps, sms: InboundSms): Promise<InboundOutcome> {
  const now = deps.now?.() ?? new Date();
  const from = normalizePhone(sms.from) ?? sms.from;
  const property = await propertyForNumber(db, sms.to);
  if (!property) return { action: "unknown_property" };

  const keyword = sms.body.trim().toLowerCase().replace(/[^a-z]/g, "");
  if (STOP.has(keyword) || START.has(keyword)) {
    const logged = await logInbound(db, property, null, from, sms, null, now);
    if (!logged) return { action: "duplicate" };
    // Twilio sends the carrier-required confirmation itself; we only record the choice.
    if (STOP.has(keyword)) {
      await db.query("insert into opt_outs (phone, opted_out_at) values ($1, $2) on conflict do nothing", [from, now.toISOString()]);
      return { action: "opted_out" };
    }
    await db.query("delete from opt_outs where phone = $1", [from]);
    return { action: "opted_in" };
  }

  const stayId = await matchStay(db, property.id, from, now);
  const lastOutbound = await db.query<{ body: string }>(
    "select body from messages where direction = 'out' and to_addr = $1 and kind <> 'alert' order by created_at desc limit 1",
    [from],
  );
  const classification = await deps.classifier.classify(sms.body, { lastOutbound: lastOutbound[0]?.body ?? null });
  const messageId = await logInbound(db, property, stayId, from, sms, classification, now);
  if (!messageId) return { action: "duplicate" };

  if (!stayId) {
    // Can't tie it to a guest (texted from another phone, report not uploaded yet). Still a person
    // reaching out to the hotel, so the desk sees it.
    if (isComplaint(classification) || isRequest(classification)) {
      await alertStaff(db, deps.messenger, property, `Text from ${from} (no matching guest): "${sms.body.trim()}"\n${staffUrl("/issues")}`, {
        includeGm: classification.urgency === "urgent",
        at: now,
      });
      return { action: "unmatched_forwarded", classification };
    }
    return { action: "no_action", classification };
  }

  const contact = (await loadContact(db, stayId))!;
  const who = `${[contact.firstName, contact.lastName].filter(Boolean).join(" ") || "Guest"}, room ${contact.room ?? "?"}`;
  let outcome: InboundOutcome;

  const [open] = await db.query<{ id: string }>(
    "select id::text from recovery_cases where stay_id = $1 and resolved_at is null order by opened_at desc limit 1",
    [stayId],
  );
  const [recent] = await db.query<{ id: string }>(
    `select id::text from recovery_cases
      where stay_id = $1 and resolved_at is not null and followup_sent_at is not null
        and followup_sent_at > $2::timestamptz - interval '24 hours'
      order by resolved_at desc limit 1`,
    [stayId, now.toISOString()],
  );

  if (open) {
    // Anything they send while an issue is open goes to the desk, so nothing gets lost.
    await db.query("update messages set case_id = $2 where id = $1", [messageId, open.id]);
    if (classification.urgency === "urgent") await db.query("update recovery_cases set urgency = 'urgent' where id = $1", [open.id]);
    await alertStaff(db, deps.messenger, property, `Update from ${who}: "${sms.body.trim()}"\n${staffUrl("/issues")}`, {
      caseId: open.id,
      stayId,
      includeGm: classification.urgency === "urgent",
      at: now,
    });
    outcome = { action: "case_updated", caseId: open.id, classification };
  } else if (recent && isComplaint(classification)) {
    // They answered our "is everything better?" with "no".
    await db.query(
      `update recovery_cases set resolved_at = null, reopened_count = reopened_count + 1, followup_due_at = null,
              followup_sent_at = null, acknowledged_at = null, acknowledged_by = null, escalated_at = null, alerted_at = $2,
              urgency = case when $3 = 'urgent' then 'urgent' else urgency end
        where id = $1`,
      [recent.id, now.toISOString(), classification.urgency],
    );
    await db.query("update messages set case_id = $2 where id = $1", [messageId, recent.id]);
    await alertStaff(db, deps.messenger, property, `REOPENED: ${who} says it's still not fixed: "${sms.body.trim()}"\n${staffUrl("/issues")}`, {
      caseId: recent.id,
      stayId,
      includeGm: true,
      at: now,
    });
    await acknowledge(db, deps.messenger, property, contact, stayId, recent.id, property.ack_template, now);
    outcome = { action: "case_reopened", caseId: recent.id, classification };
  } else if (isComplaint(classification)) {
    const [c] = await db.query<{ id: string }>(
      `insert into recovery_cases (stay_id, summary, source, category, urgency, opened_at, alerted_at)
       values ($1, $2, 'guest_text', $3, $4, $5, $5) returning id::text`,
      [stayId, classification.summary, classification.category, classification.urgency, now.toISOString()],
    );
    await db.query("update messages set case_id = $2 where id = $1", [messageId, c!.id]);
    const tag = classification.urgency === "urgent" ? "URGENT " : "";
    await alertStaff(db, deps.messenger, property, `${tag}${who}: "${sms.body.trim()}"\nReply or resolve: ${staffUrl("/issues")}`, {
      caseId: c!.id,
      stayId,
      includeGm: classification.urgency === "urgent",
      at: now,
    });
    await acknowledge(db, deps.messenger, property, contact, stayId, c!.id, property.ack_template, now);
    outcome = { action: "case_opened", caseId: c!.id, classification };
  } else if (isRequest(classification)) {
    await alertStaff(db, deps.messenger, property, `Request from ${who}: "${sms.body.trim()}"\n${staffUrl("/issues")}`, { stayId, at: now });
    await acknowledge(db, deps.messenger, property, contact, stayId, null, property.request_ack_template, now);
    outcome = { action: "request_forwarded", classification };
  } else {
    outcome = { action: "no_action", classification };
  }

  await updateSatisfaction(db, stayId);
  return outcome;
}

async function acknowledge(
  db: Db,
  messenger: Messenger,
  property: Property,
  contact: NonNullable<Awaited<ReturnType<typeof loadContact>>>,
  stayId: string,
  caseId: string | null,
  template: string,
  now: Date,
) {
  if (!contact.phone) return;
  // A guest who texted us gets a reply even without prior opt-in, but never after STOP.
  const out = await db.query("select 1 from opt_outs where phone = $1", [contact.phone]);
  if (out.length) return;
  try {
    await sendAndLog(db, messenger, {
      property,
      kind: "ack",
      channel: "sms",
      to: contact.phone,
      body: renderTemplate(template, guestVars(property, contact)),
      stayId,
      caseId,
      at: now,
    });
  } catch {
    // The desk alert already went out; a failed courtesy reply shouldn't fail the webhook.
  }
}

async function propertyForNumber(db: Db, to: string): Promise<Property | null> {
  const num = normalizePhone(to) ?? to;
  const props = await listProperties(db);
  return props.find((p) => p.sms_from === num) ?? (props.length === 1 ? props[0]! : null);
}

/** The guest this phone belongs to: in house now, else checked out in the last 3 days, else arriving within 2. */
export async function matchStay(db: Db, propertyId: string, phone: string, now: Date): Promise<string | null> {
  const [s] = await db.query<{ id: string }>(
    `select id::text from stays
      where property_id = $1 and (phone = $2 or consent_phone = $2)
        and (status = 'in_house'
          or (status = 'checked_out' and departure_date >= ($3::date - 3))
          or (status = 'reserved' and arrival_date between ($3::date - 1) and ($3::date + 2)))
      order by case status when 'in_house' then 0 when 'checked_out' then 1 else 2 end, arrival_date desc
      limit 1`,
    [propertyId, phone, now.toISOString().slice(0, 10)],
  );
  return s?.id ?? null;
}

async function logInbound(
  db: Db,
  property: Property,
  stayId: string | null,
  from: string,
  sms: InboundSms,
  classification: Classification | null,
  now: Date,
): Promise<string | null> {
  const [row] = await db.query<{ id: string }>(
    `insert into messages (property_id, stay_id, direction, channel, kind, from_addr, to_addr, body, provider_id, classification, created_at)
     values ($1, $2, 'in', 'sms', 'inbound', $3, $4, $5, $6, $7, $8)
     on conflict (provider_id) do nothing returning id::text`,
    [property.id, stayId, from, sms.to, sms.body, sms.providerId, classification ? JSON.stringify(classification) : null, now.toISOString()],
  );
  return row?.id ?? null;
}
