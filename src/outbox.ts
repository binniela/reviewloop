import { DeliveryUncertainError, ProviderConfigError, ProviderRejectedError } from "./messaging.js";
import type { Db } from "./db.js";
import { isOptedOut, sendAndLog, type SendOptions } from "./guest.js";
import { guestTextsPaused, PAUSE_RECHECK_MS, PAUSED } from "./properties.js";
import type { Messenger } from "./messaging.js";

export const deferredMessenger: Messenger = {
  deferred: true,
  send: async () => { throw new Error("Deferred messages must be persisted before dispatch"); },
};

/** How often a text held by a credentials problem tries again. */
const CONFIG_RETRY_MS = 5 * 60_000;

/** About four hours of retries with the backoff below, then a person has to look at it on Operations. */
export const MAX_SEND_ATTEMPTS = 8;

/** Durable retries for inbound side effects. A provider acceptance is not proof of handset delivery. */
export async function dispatchOutbox(db: Db, messenger: Messenger, now = new Date()) {
  const result = { sent: 0, cancelled: 0, errors: [] as string[] };
  // A crashed/expired worker has an uncertain send outcome. Do not blindly resend it.
  await db.query(`update outbound_queue set status = 'cancelled', last_error = 'Send outcome unknown after worker interruption; reconcile with provider before retrying'
    where status = 'sending' and locked_at < $1::timestamptz - interval '10 minutes'`, [now.toISOString()]);
  const rows = await db.query<{ id: string; payload: SendOptions; attempts: number }>(
    `update outbound_queue set status = 'sending', locked_at = $1, attempts = attempts + 1
     where id in (select id from outbound_queue where status = 'pending' and next_attempt_at <= $1
       order by id limit 100 for update skip locked) returning id::text, payload, attempts`, [now.toISOString()],
  );
  for (const row of rows) {
    const o = row.payload;
    try {
      if (o.channel === "sms" && o.kind !== "alert" && await isOptedOut(db, o.to)) {
        await db.query("update outbound_queue set status = 'cancelled', last_error = 'guest opted out' where id = $1", [row.id]);
        result.cancelled++;
        continue;
      }
      // Held, not dropped: it goes out once when the GM resumes texting. Staff alerts never wait.
      if (o.kind !== "alert" && await guestTextsPaused(db, o.property.id)) {
        await db.query("update outbound_queue set status = 'pending', attempts = attempts - 1, next_attempt_at = $2, last_error = $3 where id = $1",
          [row.id, new Date(now.getTime() + PAUSE_RECHECK_MS).toISOString(), PAUSED]);
        continue;
      }
      await sendAndLog(db, messenger, { ...o, outboxId: row.id, at: now, dedupeKey: `outbox:${row.id}` });
      await db.query("update outbound_queue set status = 'sent', sent_at = $2, last_error = null where id = $1", [row.id, now.toISOString()]);
      result.sent++;
    } catch (error) {
      const message = (error as Error).message;
      if (error instanceof ProviderConfigError) {
        // Not this message's fault: don't spend its retries, try again once the setting is fixed.
        await db.query("update outbound_queue set status = 'pending', attempts = attempts - 1, next_attempt_at = $2, last_error = $3 where id = $1 and status = 'sending'",
          [row.id, new Date(now.getTime() + CONFIG_RETRY_MS).toISOString(), message]);
        result.errors.push(`message ${row.id}: ${message}`);
        continue;
      }
      if (error instanceof ProviderRejectedError || row.attempts >= MAX_SEND_ATTEMPTS) {
        await db.query("update outbound_queue set status = 'failed', last_error = $2 where id = $1 and status = 'sending'", [row.id, message]);
        result.errors.push(`message ${row.id}: ${message}`);
        continue;
      }
      if (error instanceof DeliveryUncertainError) {
        await db.query("update outbound_queue set status = 'cancelled', last_error = $2 where id = $1 and status = 'sending'", [row.id, message]);
        result.errors.push(`message ${row.id}: ${message}`);
        continue;
      }
      // Retain every failure for inspection; cap retry frequency rather than dropping messages.
      const retry = new Date(now.getTime() + Math.min(60, 2 ** Math.min(row.attempts, 6)) * 60_000);
      await db.query("update outbound_queue set status = 'pending', next_attempt_at = $2, last_error = $3 where id = $1 and status = 'sending'", [row.id, retry.toISOString(), message]);
      result.errors.push(`message ${row.id}: ${message}`);
    }
  }
  return result;
}
