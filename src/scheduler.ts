import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";

/**
 * Leases and heartbeats for the scheduler, kept in sync_state so they work the same on Supabase
 * (through a transaction pooler, where session advisory locks are unsafe) and on PGlite.
 */

/** Longer than the function's maxDuration (vercel.json), so a live tick is never overlapped. */
export const TICK_LEASE_MS = 120_000;
/** No successful tick for this long means nothing is calling /cron/tick, or every tick fails. */
export const TICK_STALE_MS = 15 * 60_000;

/**
 * Takes the named lease if it is free or expired. Returns a release function, or null when another
 * run holds it. A crashed holder's lease simply expires.
 */
export async function acquireLease(db: Db, name: string, ttlMs: number, now: Date): Promise<(() => Promise<void>) | null> {
  const holder = randomUUID();
  const key = `lease:${name}`;
  const rows = await db.query(
    `insert into sync_state (key, value, updated_at) values ($1, $2, $3)
     on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at
       where sync_state.updated_at <= $3::timestamptz - make_interval(secs => $4)
     returning key`,
    [key, holder, now.toISOString(), ttlMs / 1000],
  );
  if (!rows.length) return null;
  return async () => {
    await db.query("delete from sync_state where key = $1 and value = $2", [key, holder]);
  };
}

export interface TickBeat {
  ok: boolean;
  startedAt: string;
  ms: number;
  /** Last tick that completed without throwing. Carried forward across failures. */
  lastOkAt: string | null;
  error?: string;
}

export async function lastTick(db: Db): Promise<TickBeat | null> {
  const [row] = await db.query<{ value: string }>("select value from sync_state where key = 'scheduler:tick'");
  try {
    return row ? (JSON.parse(row.value) as TickBeat) : null;
  } catch {
    return null;
  }
}

export async function recordTick(db: Db, beat: Omit<TickBeat, "lastOkAt">, now: Date) {
  const lastOkAt = beat.ok ? beat.startedAt : (await lastTick(db))?.lastOkAt ?? null;
  await db.query(
    `insert into sync_state (key, value, updated_at) values ('scheduler:tick', $1, $2)
     on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    [JSON.stringify({ ...beat, lastOkAt }), now.toISOString()],
  );
}
