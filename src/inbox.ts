import type { Db } from "./db.js";

/** Stable cursor pagination keeps complete history available without arbitrary age cutoffs. */
export async function caseHistory(db: Db, before?: string) {
  return db.query(`select c.*, c.id::text, s.property_id, s.room, s.guest_first_name, s.guest_last_name
    from recovery_cases c join stays s on s.id = c.stay_id
    where ($1::bigint is null or c.id < $1) order by c.id desc limit 100`, [before ?? null]);
}
export async function conversationHistory(db: Db, stayId: string, before?: string) {
  return db.query(`select id::text, direction, channel, kind, body, created_at, case_id::text, from_addr, to_addr
    from messages where stay_id = $1 and kind <> 'alert' and ($2::bigint is null or id < $2)
    order by id desc limit 100`, [stayId, before ?? null]);
}
export async function unmatchedMessages(db: Db, before?: string) {
  return db.query(`select id::text, property_id, from_addr, body, created_at, classification
    from messages where direction = 'in' and stay_id is null and classification is not null
      and ($1::bigint is null or id < $1) order by id desc limit 100`, [before ?? null]);
}
