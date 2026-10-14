import type { Db } from "../db.js";

/**
 * Stay satisfaction from -1 (unhappy) to 1 (happy), or null with no signal yet.
 *
 * Signals: the sentiment of each guest text, plus each issue (open: -1, resolved: -0.25,
 * each reopen another -0.5). Shown to staff and on the metrics page. It never decides whether
 * a guest is asked for a review.
 */
export async function updateSatisfaction(db: Db, stayId: string): Promise<number | null> {
  // Each signal with the time it happened, so later news (a fix, "all good now") weighs more.
  const rows = await db.query<{ value: number; at: Date }>(
    `select case classification->>'sentiment' when 'positive' then 1 when 'negative' then -1 else 0 end::float as value,
            created_at as at
       from messages where stay_id = $1 and direction = 'in' and classification is not null
     union all
     select ((case when resolved_at is null then -1 else -0.25 end) - 0.5 * reopened_count)::float, coalesce(resolved_at, opened_at)
       from recovery_cases where stay_id = $1 and kind = 'complaint'`,
    [stayId],
  );
  if (!rows.length) return null;
  const signals = rows.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()).map((r) => Number(r.value));
  const weights = signals.map((_, i) => 1 + i * 0.5);
  const score = signals.reduce((sum, s, i) => sum + s * weights[i]!, 0) / weights.reduce((a, b) => a + b, 0);
  const clamped = Math.max(-1, Math.min(1, Math.round(score * 100) / 100));
  await db.query("update stays set satisfaction = $2 where id = $1", [stayId, clamped]);
  return clamped;
}
