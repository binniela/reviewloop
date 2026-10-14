import type { Db } from "./db.js";
const ranks: Record<string, number> = { accepted: 0, scheduled: 0, queued: 1, sending: 2, sent: 3, failed: 4, undelivered: 4, delivered: 5, read: 6 };
export async function recordDelivery(db: Db, id: string, status: string, errorCode: string | undefined, now = new Date(), outboxId?: string) {
  const rank = ranks[status];
  if (rank === undefined || !id) return false;
  await db.transaction(async (tx) => {
    if (outboxId && /^\d+$/.test(outboxId)) {
      const [row] = await tx.query<{ payload: { property: { id: string; sms_from: string | null }; stayId?: string; caseId?: string; kind: string; channel: string; to: string; body: string }; status: string }>(
        "select payload, status from outbound_queue where id = $1 for update", [outboxId],
      );
      if (row && row.payload.channel === "sms") {
        const o = row.payload;
        await tx.query(`insert into messages (property_id, stay_id, case_id, direction, channel, kind, from_addr, to_addr, body, provider_id, created_at, dedupe_key)
          values ($1, $2, $3, 'out', 'sms', $4, $5, $6, $7, $8, $9, $10)
          on conflict (provider_id) do nothing`,
          [o.property.id, o.stayId ?? null, o.caseId ?? null, o.kind, o.property.sms_from, o.to, o.body, id, now.toISOString(), `outbox:${outboxId}`]);
        await tx.query("update outbound_queue set status = 'sent', sent_at = $2, last_error = null where id = $1 and status in ('sending', 'cancelled', 'failed')", [outboxId, now.toISOString()]);
      }
    }
    await tx.query(`insert into sms_delivery_receipts (provider_id, status, rank, error_code, updated_at) values ($1, $2, $3, $4, $5)
      on conflict (provider_id) do update set status = excluded.status, rank = excluded.rank, error_code = excluded.error_code, updated_at = excluded.updated_at
      where excluded.rank > sms_delivery_receipts.rank`, [id, status, rank, errorCode ?? null, now.toISOString()]);
  });
  return true;
}
