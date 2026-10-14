import { DeliveryUncertainError } from "../messaging.js";
import { DateTime } from "luxon";
import type { Db } from "../db.js";
import type { Messenger } from "../messaging.js";
import { getProperty, scheduledCheckout } from "../properties.js";
import { sendReviewRequest, type JobOutcome } from "../reviews/requests.js";
import { midStayTime, sendMidStay, sendWelcome } from "./inStay.js";

/**
 * Milestone engine. Turns stay events into scheduled jobs, then runs jobs when due.
 *
 *   welcome         on check-in
 *   mid_stay        morning after arrival (2+ night stays)
 *   review_request  after checkout
 *
 * Jobs follow the reservation: they move when dates change, in-stay jobs are cancelled at
 * checkout, and everything is cancelled with the reservation.
 */

type Handler = (db: Db, stayId: string, messenger: Messenger, now: Date) => Promise<JobOutcome>;
const HANDLERS: Record<string, Handler> = {
  welcome: sendWelcome,
  mid_stay: sendMidStay,
  review_request: sendReviewRequest,
};

interface EventRow {
  id: string;
  type: string;
  stay_id: string | null;
  property_id: string;
  occurred_at: Date;
}

interface StayTiming {
  status: string;
  arrival_date: string;
  departure_date: string;
  checked_out_at: Date | string | null;
}

export async function processEvents(db: Db, limit = 500): Promise<number> {
  const events = await db.query<EventRow>(
    `select id::text, type, stay_id::text, property_id, occurred_at from events
      where processed_at is null order by id limit $1`,
    [limit],
  );
  for (const e of events) {
    if (e.stay_id) await applyEvent(db, { ...e, stay_id: e.stay_id });
    await db.query("update events set processed_at = now() where id = $1", [e.id]);
  }
  return events.length;
}

async function cancelJobs(db: Db, stayId: string, kinds: string[] | null, reason: string) {
  await db.query(
    `update jobs set status = 'cancelled', result = $3, updated_at = now()
      where stay_id = $1 and status = 'pending' and ($2::text[] is null or kind = any($2::text[]))`,
    [stayId, kinds, reason],
  );
}

async function applyEvent(db: Db, e: EventRow & { stay_id: string }) {
  if (e.type === "reservation.cancelled") return cancelJobs(db, e.stay_id, null, "reservation cancelled");

  const [stay] = await db.query<StayTiming>(
    `select status, arrival_date::text as arrival_date, departure_date::text as departure_date, checked_out_at
       from stays where id = $1`,
    [e.stay_id],
  );
  if (!stay || stay.status === "cancelled" || stay.status === "no_show") return;
  const property = await getProperty(db, e.property_id);

  if (e.type === "guest.checked_out") await cancelJobs(db, e.stay_id, ["welcome", "mid_stay"], "guest checked out");

  if (e.type === "guest.checked_in") await scheduleJob(db, e.stay_id, "welcome", new Date(e.occurred_at));

  if (stay.status === "in_house" && (e.type === "guest.checked_in" || e.type === "reservation.modified")) {
    const mid = midStayTime(property, stay.arrival_date, stay.departure_date);
    if (mid) await scheduleJob(db, e.stay_id, "mid_stay", mid.toJSDate());
    else await cancelJobs(db, e.stay_id, ["mid_stay"], "stay too short");
  }

  if (["reservation.created", "reservation.modified", "guest.checked_out"].includes(e.type)) {
    const checkout = stay.checked_out_at
      ? DateTime.fromJSDate(new Date(stay.checked_out_at))
      : scheduledCheckout(property, stay.departure_date);
    const runAt = checkout.plus({ minutes: property.review_delay_min });
    await scheduleJob(db, e.stay_id, "review_request", runAt.toJSDate());
  }
}

/** Creates the job, or moves it if it's still pending. Finished jobs are never revived. */
export async function scheduleJob(db: Db, stayId: string, kind: string, runAt: Date) {
  await db.query(
    `insert into jobs (stay_id, kind, run_at) values ($1, $2, $3)
     on conflict (stay_id, kind) do update set run_at = excluded.run_at, updated_at = now()
       where jobs.status = 'pending'`,
    [stayId, kind, runAt.toISOString()],
  );
}

export interface RunDeps {
  messenger: Messenger;
  now?: () => Date;
  limit?: number;
}

export interface RunSummary {
  done: number;
  skipped: number;
  deferred: number;
  failed: number;
  retrying: number;
}

const MAX_ATTEMPTS = 5;

export async function runDueJobs(db: Db, deps: RunDeps): Promise<RunSummary> {
  const now = deps.now?.() ?? new Date();
  const summary: RunSummary = { done: 0, skipped: 0, deferred: 0, failed: 0, retrying: 0 };

  // After a crash the provider may already have accepted a message. Surface the uncertain
  // outcome for reconciliation instead of leaving it running forever or blindly resending.
  await db.query(`update jobs set status = 'failed', result = 'Worker interrupted; provider outcome unknown. Reconcile before retrying.', updated_at = $1
    where status = 'running' and updated_at < $1::timestamptz - interval '15 minutes'`, [now.toISOString()]);

  // Claim due jobs so overlapping cron runs don't double-send.
  const jobs = await db.query<{ id: string; stay_id: string; kind: string; attempts: number }>(
    `update jobs set status = 'running', attempts = attempts + 1, updated_at = $1
      where id in (select id from jobs where status = 'pending' and run_at <= $1
                   order by run_at limit $2 for update skip locked)
      returning id::text, stay_id::text, kind, attempts`,
    [now.toISOString(), deps.limit ?? 100],
  );

  for (const job of jobs) {
    let outcome: JobOutcome;
    try {
      const handler = HANDLERS[job.kind];
      outcome = handler
        ? await handler(db, job.stay_id, deps.messenger, now)
        : { status: "skipped", result: `no handler for ${job.kind}` };
    } catch (err) {
      const message = (err as Error).message;
      if (err instanceof DeliveryUncertainError || job.attempts >= MAX_ATTEMPTS) {
        await finish(db, job.id, "failed", message);
        summary.failed++;
      } else {
        const retryAt = new Date(now.getTime() + 15 * 60_000 * job.attempts);
        await db.query(
          "update jobs set status = 'pending', run_at = $2, result = $3, updated_at = now() where id = $1",
          [job.id, retryAt.toISOString(), `retrying: ${message}`],
        );
        summary.retrying++;
      }
      continue;
    }

    if (outcome.status === "deferred") {
      // Deferral is a scheduling decision, not a failed attempt.
      await db.query(
        "update jobs set status = 'pending', run_at = $2, attempts = attempts - 1, result = $3, updated_at = now() where id = $1",
        [job.id, outcome.runAt.toISOString(), outcome.result],
      );
      summary.deferred++;
    } else {
      await finish(db, job.id, outcome.status, outcome.result);
      summary[outcome.status]++;
    }
  }
  return summary;
}

async function finish(db: Db, id: string, status: string, result: string) {
  await db.query("update jobs set status = $2, result = $3, updated_at = now() where id = $1", [id, status, result]);
}
