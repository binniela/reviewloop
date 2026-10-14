import { createHash } from "node:crypto";
import type { Db } from "./db.js";

/** Atomic, database-backed fixed-window limit shared by all app instances. */
export async function rateLimited(db: Db, scope: string, value: string, limit: number, now = new Date()): Promise<boolean> {
  const key = createHash("sha256").update(`${scope}:${value}`).digest("hex");
  const [row] = await db.query<{ attempts: number }>(
    `insert into request_limits (key, window_start, attempts) values ($1, $2, 1)
     on conflict (key) do update set
       window_start = case when request_limits.window_start <= $2::timestamptz - interval '1 hour' then $2 else request_limits.window_start end,
       attempts = case when request_limits.window_start <= $2::timestamptz - interval '1 hour' then 1 else request_limits.attempts + 1 end
     returning attempts`, [key, now.toISOString()],
  );
  return row!.attempts > limit;
}

/** Failures counted so far this window, without adding one. Used where only wrong guesses should count (PINs). */
export async function attemptsSoFar(db: Db, scope: string, value: string, now = new Date()): Promise<number> {
  const key = createHash("sha256").update(`${scope}:${value}`).digest("hex");
  const [row] = await db.query<{ attempts: number }>(
    "select attempts from request_limits where key = $1 and window_start > $2::timestamptz - interval '1 hour'", [key, now.toISOString()],
  );
  return row?.attempts ?? 0;
}

export async function clearLimit(db: Db, scope: string, value: string): Promise<void> {
  await db.query("delete from request_limits where key = $1", [createHash("sha256").update(`${scope}:${value}`).digest("hex")]);
}

/** Browser writes must originate at our public origin; API clients using Basic auth have no Origin. */
export function sameOrigin(requestUrl: string, origin: string | undefined, referer: string | undefined, publicUrl?: string): boolean {
  const expected = new URL(publicUrl ?? requestUrl).origin;
  try { return new URL(origin ?? referer ?? "").origin === expected; }
  catch { return false; }
}
