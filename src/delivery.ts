import type { Db } from "./db.js";
const ranks: Record<string, number> = { accepted: 0, scheduled: 0, queued: 1, sending: 2, sent: 3, failed: 4, undelivered: 4, delivered: 5, read: 6 };
export async function recordDelivery(db: Db, id: string, status: string, errorCode: string | undefined, now = new Date()) {
  const rank = ranks[status];
  if (rank === undefined || !id) return false;
  await db.query(`insert into sms_delivery_receipts (provider_id, status, rank, error_code, updated_at) values ($1, $2, $3, $4, $5)
    on conflict (provider_id) do update set status = excluded.status, rank = excluded.rank, error_code = excluded.error_code, updated_at = excluded.updated_at
    where excluded.rank > sms_delivery_receipts.rank`, [id, status, rank, errorCode ?? null, now.toISOString()]);
  return true;
}
