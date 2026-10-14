import { createHash } from "node:crypto";
import type { Db } from "../db.js";
import type { ReservationSnapshot, StayStatus } from "./asiReport.js";

/**
 * Compares reservation snapshots from a PMS report against stored stays and records what
 * changed as events. Safe to run repeatedly on overlapping data: unchanged rows are no-ops,
 * and every event carries an idempotency key, so the same change is never recorded twice.
 *
 * Reports cover a window (today's departures, current in-house list), so a reservation
 * missing from a report is NOT treated as cancelled. Only explicit statuses change state.
 */

export type EventType =
  | "reservation.created"
  | "reservation.modified"
  | "reservation.cancelled"
  | "guest.checked_in"
  | "guest.checked_out";

export interface ReconcileResult {
  created: number;
  updated: number;
  unchanged: number;
  ignoredRegressions: number;
  events: number;
}

const TRACKED_FIELDS = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "smsOptIn",
  "room",
  "channel",
  "arrivalDate",
  "departureDate",
  "status",
] as const satisfies readonly (keyof ReservationSnapshot)[];

// Order of a normal stay. A stale report must never move a guest backwards along it.
const PROGRESS: Partial<Record<StayStatus, number>> = { reserved: 0, in_house: 1, checked_out: 2 };

interface StoredStay {
  id: string;
  status: StayStatus;
  state_hash: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  sms_opt_in: boolean;
  room: string | null;
  channel: string | null;
  arrival_date: string;
  departure_date: string;
}

export function stateHash(s: ReservationSnapshot): string {
  const tracked = TRACKED_FIELDS.map((f) => s[f] ?? null);
  return createHash("sha256").update(JSON.stringify(tracked)).digest("hex").slice(0, 16);
}

export async function reconcile(
  db: Db,
  propertyId: string,
  snapshots: ReservationSnapshot[],
  now: Date = new Date(),
): Promise<ReconcileResult> {
  const result: ReconcileResult = { created: 0, updated: 0, unchanged: 0, ignoredRegressions: 0, events: 0 };

  for (const incoming of snapshots) {
    const [existing] = await db.query<StoredStay>(
      `select id::text, status, state_hash, guest_first_name as first_name, guest_last_name as last_name,
              email, phone, sms_opt_in, room, channel,
              arrival_date::text as arrival_date, departure_date::text as departure_date
         from stays where property_id = $1 and confirmation = $2`,
      [propertyId, incoming.confirmation],
    );

    const snap = { ...incoming };
    if (existing && isRegression(existing.status, snap.status)) {
      // e.g. yesterday's in-house report uploaded after the guest left. Keep the later status,
      // but still accept contact/room corrections from the row.
      snap.status = existing.status;
      result.ignoredRegressions++;
    }
    const hash = stateHash(snap);
    if (existing && existing.state_hash === hash) {
      result.unchanged++;
      continue;
    }

    const stayId = await upsertStay(db, propertyId, snap, hash, existing?.status ?? null, now);
    const events: { type: EventType; key: string; payload: Record<string, unknown>; at: Date }[] = [];
    const key = (type: EventType, disc: string) => `${propertyId}:${snap.confirmation}:${type}:${disc}`;

    if (!existing) {
      result.created++;
      events.push({ type: "reservation.created", key: key("reservation.created", "1"), payload: {}, at: now });
    } else {
      result.updated++;
      const changed = changedFields(existing, snap);
      if (changed.length > 0) {
        events.push({
          type: "reservation.modified",
          key: key("reservation.modified", hash),
          payload: { changed },
          at: now,
        });
      }
    }

    const prev = existing?.status ?? null;
    if (snap.status !== prev) {
      if ((snap.status === "in_house" || snap.status === "checked_out") && rank(prev) < 1) {
        // A guest first seen as checked out still checked in; record it so Phase 2 milestones stay consistent.
        events.push({ type: "guest.checked_in", key: key("guest.checked_in", "1"), payload: {}, at: now });
      }
      if (snap.status === "checked_out") {
        const at = snap.checkedOutAt ? new Date(snap.checkedOutAt) : now;
        events.push({
          type: "guest.checked_out",
          key: key("guest.checked_out", "1"),
          payload: { checkedOutAt: snap.checkedOutAt },
          at,
        });
      }
      if (snap.status === "cancelled" || snap.status === "no_show") {
        events.push({
          type: "reservation.cancelled",
          key: key("reservation.cancelled", snap.status),
          payload: { status: snap.status },
          at: now,
        });
      }
    }

    for (const e of events) {
      const inserted = await db.query(
        `insert into events (property_id, stay_id, type, idempotency_key, payload, occurred_at)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (idempotency_key) do nothing
         returning id`,
        [propertyId, stayId, e.type, e.key, JSON.stringify(e.payload), e.at.toISOString()],
      );
      result.events += inserted.length;
    }
  }
  return result;
}

function rank(s: StayStatus | null): number {
  return s == null ? -1 : (PROGRESS[s] ?? -1);
}

function isRegression(from: StayStatus, to: StayStatus): boolean {
  if (from === "checked_out") return to !== "checked_out";
  return rank(to) >= 0 && rank(to) < rank(from);
}

function changedFields(old: StoredStay, s: ReservationSnapshot): string[] {
  const pairs: [string, unknown, unknown][] = [
    ["firstName", old.first_name, s.firstName],
    ["lastName", old.last_name, s.lastName],
    ["email", old.email, s.email],
    ["phone", old.phone, s.phone],
    ["smsOptIn", old.sms_opt_in, s.smsOptIn],
    ["room", old.room, s.room],
    ["channel", old.channel, s.channel],
    ["arrivalDate", old.arrival_date, s.arrivalDate],
    ["departureDate", old.departure_date, s.departureDate],
  ];
  return pairs.filter(([, a, b]) => (a ?? null) !== (b ?? null)).map(([f]) => f);
}

async function upsertStay(
  db: Db,
  propertyId: string,
  s: ReservationSnapshot,
  hash: string,
  prevStatus: StayStatus | null,
  now: Date,
): Promise<string> {
  const checkedInAt = s.status === "in_house" && prevStatus !== "in_house" ? now.toISOString() : null;
  const checkedOutAt =
    s.status === "checked_out" && prevStatus !== "checked_out" ? (s.checkedOutAt ?? null) : null;
  const [row] = await db.query<{ id: string }>(
    `insert into stays (property_id, confirmation, guest_first_name, guest_last_name, email, phone, sms_opt_in,
                        room, channel, arrival_date, departure_date, status, checked_in_at, checked_out_at,
                        state_hash, first_seen_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)
     on conflict (property_id, confirmation) do update set
       guest_first_name = excluded.guest_first_name,
       guest_last_name  = excluded.guest_last_name,
       email            = excluded.email,
       phone            = excluded.phone,
       sms_opt_in       = excluded.sms_opt_in,
       room             = excluded.room,
       channel          = excluded.channel,
       arrival_date     = excluded.arrival_date,
       departure_date   = excluded.departure_date,
       status           = excluded.status,
       checked_in_at    = coalesce(stays.checked_in_at, excluded.checked_in_at),
       checked_out_at   = coalesce(stays.checked_out_at, excluded.checked_out_at),
       state_hash       = excluded.state_hash,
       updated_at       = excluded.updated_at
     returning id::text`,
    [
      propertyId,
      s.confirmation,
      s.firstName,
      s.lastName,
      s.email,
      s.phone,
      s.smsOptIn,
      s.room,
      s.channel,
      s.arrivalDate,
      s.departureDate,
      s.status,
      checkedInAt,
      checkedOutAt,
      hash,
      now.toISOString(),
    ],
  );
  return row!.id;
}
