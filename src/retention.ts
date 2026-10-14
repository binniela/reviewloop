import type { Db } from "./db.js";

/** Remove guest contact and conversation detail after the configured retention period. */
export async function purgeGuestPii(db: Db, now = new Date(), days = 365): Promise<void> {
  if (!Number.isInteger(days) || days < 30) throw new Error("PII_RETENTION_DAYS must be at least 30");
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  await db.transaction(async (tx) => {
    // Expired, unverified public sign-ups never became consent and should disappear quickly.
    await tx.query("delete from consents where stay_id is null and created_at < $1::timestamptz - interval '2 days'", [now.toISOString()]);
    await tx.query(`update messages set from_addr = null, to_addr = '[redacted]', body = '[redacted]', classification = null
      where stay_id in (select id from stays where status in ('checked_out', 'cancelled', 'no_show') and departure_date < $1::date)
        and body <> '[redacted]'`, [cutoff]);
    await tx.query(`update recovery_cases set summary = '[redacted]', resolution = null
      where stay_id in (select id from stays where status in ('checked_out', 'cancelled', 'no_show') and departure_date < $1::date)
        and summary <> '[redacted]'`, [cutoff]);
    await tx.query(`update review_requests set destination = '[redacted]', body = '[redacted]'
      where stay_id in (select id from stays where status in ('checked_out', 'cancelled', 'no_show') and departure_date < $1::date)
        and destination <> '[redacted]'`, [cutoff]);
    await tx.query(`update consents set phone = '[redacted]', last_name = '[redacted]', room = '[redacted]'
      where stay_id in (select id from stays where status in ('checked_out', 'cancelled', 'no_show') and departure_date < $1::date)
        and phone <> '[redacted]'`, [cutoff]);
    await tx.query(`update stays set guest_first_name = null, guest_last_name = null, email = null, phone = null,
      consent_phone = null, room = null, channel = null
      where status in ('checked_out', 'cancelled', 'no_show') and departure_date < $1::date
        and (guest_first_name is not null or guest_last_name is not null or email is not null or phone is not null
          or consent_phone is not null or room is not null or channel is not null)`, [cutoff]);
    await tx.query(`update outbound_queue set payload = '{}'::jsonb, last_error = null
      where status in ('sent', 'cancelled', 'failed') and coalesce(sent_at, locked_at, next_attempt_at) < $1
        and payload <> '{}'::jsonb`, [cutoff]);
    // Unmatched incoming texts have no stay to anchor them to the cutoff above.
    await tx.query(`update messages set from_addr = null, to_addr = '[redacted]', body = '[redacted]', classification = null
      where stay_id is null and created_at < $1 and body <> '[redacted]'`, [cutoff]);
  });
}

/** Keep routine cleanup off every frequent cron pass. Concurrent calls are harmless. */
export async function runRetentionIfDue(db: Db, now = new Date(), days = 365): Promise<void> {
  const [last] = await db.query<{ updated_at: Date }>("select updated_at from sync_state where key = 'pii_retention'");
  if (last && now.getTime() - new Date(last.updated_at).getTime() < 86_400_000) return;
  await purgeGuestPii(db, now, days);
  await db.query(`insert into sync_state (key, value, updated_at) values ('pii_retention', $1, $2)
    on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
  [String(days), now.toISOString()]);
}
