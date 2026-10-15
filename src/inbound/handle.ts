import { deferredMessenger, dispatchOutbox } from "../outbox.js";
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
const START = new Set(["start", "unstop"]);
// Carrier HELP keywords. Twilio's opt-out handling replies to these with the HELP text configured
// for the number, so we don't send our own acknowledgement and don't treat "help" as urgent. The
// desk still gets the text: a guest who sends it may really want someone.
const HELP = new Set(["help", "info"]);
const HELP_CLASSIFICATION: Classification = { sentiment: "neutral", category: "request", urgency: "normal", summary: "Texted HELP", by: "keywords" };

// A guest who writes "please stop texting me" has opted out as surely as one who sends STOP.
// Deliberately broad: wrongly honoring an opt-out costs a text; ignoring one costs the guest's trust
// and a compliance problem. "Stop by with towels" and "the noise won't stop" don't match.
const OPT_OUT_PHRASES = [
  /\b(stop|quit|cease)\s+(texting|messaging|sending|contacting|txting)\b/i,
  /\b(don'?t|do not|dont|never)\s+(text|message|sms|contact)\b/i,
  /\bno more (texts|messages|sms)\b/i,
  /\bunsubscribe\b/i,
  /\bopt(\s|-)?(me\s+)?out\b/i,
  /\b(remove|take) me (from|off)\b/i,
  /^\s*(please\s+)?stop[\s,.!]*(please|now|it|this|thanks?|thank you)?[\s.!]*$/i,
];

/** A carrier keyword (STOP), or an opt-out written in plain words. */
export function isOptOutPhrase(body: string): boolean {
  return OPT_OUT_PHRASES.some((re) => re.test(body));
}

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
  // Model calls run before locking the property so a slow classifier cannot block STOP
  // processing or other guests. The transaction rechecks deduplication and current case state.
  let classifier = deps.classifier;
  const keyword = sms.body.trim().toLowerCase().replace(/[^a-z]/g, "");
  const property = await propertyForNumber(db, sms.to);
  if (!property) return { action: "unknown_property" };
  if (!STOP.has(keyword) && !START.has(keyword) && !isOptOutPhrase(sms.body) && !(await db.query("select 1 from messages where provider_id = $1", [sms.providerId])).length) {
    const from = normalizePhone(sms.from) ?? sms.from;
    const stay = await matchStay(db, property.id, from, deps.now?.() ?? new Date());
    const [last] = await db.query<{ body: string }>(
      "select body from messages where property_id = $1 and stay_id = $2 and to_addr = $3 and direction = 'out' and kind <> 'alert' order by created_at desc, id desc limit 1", [property.id, stay, from],
    );
    const classification = HELP.has(keyword) ? HELP_CLASSIFICATION : await deps.classifier.classify(sms.body, { lastOutbound: last?.body ?? null });
    classifier = { classify: async () => classification };
  }
  // Persist the incoming message, case changes, and outgoing work together. No provider sends inside
  // the transaction: a retry can never mistake partially processed input for completed work.
  const outcome = await db.transaction(async (tx) => {
    await tx.query("select id from properties where sms_from = $1 for update", [normalizePhone(sms.to) ?? sms.to]);
    return processInbound(tx, { ...deps, classifier, messenger: deferredMessenger }, sms);
  });
  await dispatchOutbox(db, deps.messenger, deps.now?.() ?? new Date());
  return outcome;
}

async function processInbound(db: Db, deps: InboundDeps, sms: InboundSms): Promise<InboundOutcome> {
  const now = deps.now?.() ?? new Date();
  const from = normalizePhone(sms.from) ?? sms.from;
  const property = await propertyForNumber(db, sms.to);
  if (!property) return { action: "unknown_property" };

  if ((await db.query("select 1 from messages where provider_id = $1", [sms.providerId])).length) return { action: "duplicate" };
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
  if (isOptOutPhrase(sms.body)) {
    const logged = await logInbound(db, property, stayId, from, sms, null, now);
    if (!logged) return { action: "duplicate" };
    await db.query("insert into opt_outs (phone, opted_out_at) values ($1, $2) on conflict do nothing", [from, now.toISOString()]);
    // No reply to the guest. A person at the desk still sees it, in case they meant something else.
    const contact = stayId ? await loadContact(db, stayId) : null;
    const who = contact ? `${[contact.firstName, contact.lastName].filter(Boolean).join(" ") || "Guest"}, room ${contact.room ?? "?"}` : from;
    await alertStaff(db, deps.messenger, property, `${who} asked not to get texts. We won't text them again unless they text START: "${sms.body.trim()}"\n${staffUrl("/issues")}`, {
      stayId,
      at: now,
    });
    return { action: "opted_out" };
  }
  const lastOutbound = await db.query<{ id: string; body: string; kind: string; case_id: string | null }>(
    "select id::text, body, kind, case_id::text from messages where direction = 'out' and to_addr = $1 and property_id = $2 and kind <> 'alert' and stay_id = $3 order by created_at desc, id desc limit 1",
    [from, property.id, stayId],
  );
  const classification = await deps.classifier.classify(sms.body, { lastOutbound: lastOutbound[0]?.body ?? null });
  const messageId = await logInbound(db, property, stayId, from, sms, classification, now);
  if (!messageId) return { action: "duplicate" };
  if (lastOutbound[0]) await db.query("update messages set in_reply_to = $2 where id = $1", [messageId, lastOutbound[0].id]);

  if (!stayId) {
    // Can't tie it to a guest (texted from another phone, report not uploaded yet). Still a person
    // reaching out to the hotel, so the desk sees it.
    if (isComplaint(classification) || isRequest(classification) || classification.category !== "praise") {
      await alertStaff(db, deps.messenger, property, `Text from ${from} (no matching guest): "${sms.body.trim()}"\n${staffUrl("/issues")}`, {
        includeGm: classification.urgency === "urgent",
        at: now,
      });
      return { action: "unmatched_forwarded", classification };
    }
    return { action: "no_action", classification };
  }

  const contact = (await loadContact(db, stayId))!;
  // Replies belong to the verified inbound sender, not a different phone on the stay.
  contact.phone = from;
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
    if (isComplaint(classification)) await db.query("update recovery_cases set kind = 'complaint', summary = $2, category = $3 where id = $1 and kind = 'request'", [open.id, classification.summary, classification.category]);
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
              followup_sent_at = null, followup_claimed_at = null, followup_error = null, acknowledged_at = null, acknowledged_by = null, escalated_at = null, escalation_error = null, escalation_next_attempt_at = null, guest_confirmed_at = null, alerted_at = $2,
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
  } else if (isComplaint(classification) || isRequest(classification) || classification.category !== "praise") {
    const complaint = isComplaint(classification);
    const [c] = await db.query<{ id: string }>(
      `insert into recovery_cases (stay_id, summary, source, category, urgency, opened_at, alerted_at, kind)
       values ($1, $2, 'guest_text', $3, $4, $5, $5, $6) returning id::text`,
      [stayId, classification.summary, classification.category, classification.urgency, now.toISOString(), complaint ? "complaint" : "request"],
    );
    await db.query("update messages set case_id = $2 where id = $1", [messageId, c!.id]);
    const tag = classification.urgency === "urgent" ? "URGENT " : complaint ? "" : "Request from ";
    await alertStaff(db, deps.messenger, property, `${tag}${who}: "${sms.body.trim()}"\nReply or resolve: ${staffUrl("/issues")}`, {
      caseId: c!.id,
      stayId,
      includeGm: classification.urgency === "urgent",
      at: now,
    });
    if (!HELP.has(keyword)) await acknowledge(db, deps.messenger, property, contact, stayId, c!.id, complaint ? property.ack_template : property.request_ack_template, now);
    outcome = { action: "case_opened", caseId: c!.id, classification };
  } else {
    if (recent && classification.sentiment === "positive" && lastOutbound[0]?.kind === "followup" && lastOutbound[0].case_id === recent.id) {
      await db.query("update recovery_cases set guest_confirmed_at = $2 where id = $1", [recent.id, now.toISOString()]);
    }
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
  return props.find((p) => p.sms_from === num) ?? null;
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
