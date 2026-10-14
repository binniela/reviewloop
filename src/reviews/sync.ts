import { DateTime } from "luxon";
import type { Db } from "../db.js";
import { getProperty, type Property, type ReplyMode } from "../properties.js";
import { firstName, type ReplyDrafter } from "./drafter.js";
import type { ReviewSource } from "./sources.js";

/** Reviews older than this when first seen are stored but not drafted (avoids replying to years of backlog). */
const DRAFT_WINDOW_DAYS = 30;

/** Topics a person should always read before anything is posted, whatever the reply mode. */
const SENSITIVE =
  /\b(injur\w*|hurt|hospital|police|lawsuit|lawyer|attorney|sue|assault\w*|harass\w*|discriminat\w*|racis\w*|theft|stolen|bed ?bugs?|mold|carbon monoxide|unsafe|danger\w*|refund|chargeback)\b/i;

export type Decision = "auto" | "approval";

export function decide(mode: ReplyMode, rating: number | null, body: string | null): { decision: Decision; reason: string } {
  if (body && SENSITIVE.test(body)) return { decision: "approval", reason: "sensitive topic" };
  if (mode === "auto_all") return { decision: "auto", reason: "auto_all" };
  if (mode === "auto_high" && rating !== null && rating >= 4) return { decision: "auto", reason: "4+ stars" };
  return { decision: "approval", reason: mode === "approval_all" ? "approval_all" : "3 stars or less" };
}

export interface SyncDeps {
  source: ReviewSource;
  drafter: ReplyDrafter;
  now?: () => Date;
}

export interface SyncSummary {
  fetched: number;
  newReviews: number;
  drafted: number;
  autoPosted: number;
  awaitingApproval: number;
  errors: string[];
}

export async function syncReviews(db: Db, propertyId: string, deps: SyncDeps): Promise<SyncSummary> {
  const property = await getProperty(db, propertyId);
  const now = DateTime.fromJSDate(deps.now?.() ?? new Date());
  const summary: SyncSummary = { fetched: 0, newReviews: 0, drafted: 0, autoPosted: 0, awaitingApproval: 0, errors: [] };

  const reviews = await deps.source.fetchReviews(property);
  summary.fetched = reviews.length;

  const totals = deps.source.summary(property);
  if (totals) {
    await db.query(
      `insert into review_snapshots (property_id, source, day, review_count, avg_rating) values ($1, $2, $3, $4, $5)
       on conflict (property_id, source, day) do update set review_count = excluded.review_count, avg_rating = excluded.avg_rating`,
      [property.id, deps.source.name, now.setZone(property.timezone).toISODate(), totals.count, totals.average],
    );
  }

  for (const r of reviews) {
    const [row] = await db.query<{ id: string; inserted: boolean }>(
      `insert into reviews (property_id, source, external_id, author, rating, body, reviewed_at, existing_reply, synced_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (source, external_id) do update set
         rating = excluded.rating, body = excluded.body,
         existing_reply = excluded.existing_reply, synced_at = excluded.synced_at
       returning id::text, (xmax = 0) as inserted`,
      [property.id, deps.source.name, r.externalId, r.author, r.rating, r.body, r.reviewedAt, r.existingReply, now.toISO()],
    );
    if (row!.inserted) summary.newReviews++;
  }

  // Someone replied directly on the platform: retire our draft so it's never posted on top.
  await db.query(
    `update reply_drafts d set status = 'dismissed', decided_by = 'replied outside app', decided_at = now()
       from reviews r
      where r.id = d.review_id and r.property_id = $1 and r.existing_reply is not null
        and d.status in ('pending', 'failed')`,
    [property.id],
  );

  // Draft for any recent review with no reply and no draft yet.
  const pending = await db.query<{ id: string; author: string | null; rating: number | null; body: string | null; reviewed_at: Date }>(
    `select r.id::text, r.author, r.rating, r.body, r.reviewed_at from reviews r
      where r.property_id = $1 and r.existing_reply is null and r.reviewed_at >= $2
        and not exists (select 1 from reply_drafts d where d.review_id = r.id)
      order by r.reviewed_at`,
    [property.id, now.minus({ days: DRAFT_WINDOW_DAYS }).toISO()],
  );

  for (const review of pending) {
    try {
      const stayId = await matchStay(db, property, review.author, new Date(review.reviewed_at));
      if (stayId) await db.query("update reviews set stay_id = $2 where id = $1 and stay_verified_at is null", [review.id, stayId]);
      // A unique name/date match is still only a guess. Never send private stay data to
      // the model unless staff explicitly verified the review-to-stay association.
      const [verified] = await db.query<{ stay_id: string }>(
        "select stay_id::text from reviews where id = $1 and stay_verified_at is not null", [review.id],
      );
      const stayNotes = verified?.stay_id ? await recoveryNotes(db, verified.stay_id) : [];
      const voiceExamples = await recentEdits(db, property.id);
      const draft = await deps.drafter.draft({ property, review, stayNotes, voiceExamples });

      const { decision } = decide(property.reply_mode, review.rating, review.body);
      const [d] = await db.query<{ id: string }>(
        `insert into reply_drafts (review_id, draft, status, decided_by, decided_at)
         values ($1, $2, $3, $4, $5) returning id::text`,
        decision === "auto"
          ? [review.id, draft, "approved", "auto", now.toISO()]
          : [review.id, draft, "pending", null, null],
      );
      summary.drafted++;
      if (decision === "auto") {
        const posted = await postDraft(db, d!.id, deps.source, property);
        if (posted.ok) summary.autoPosted++;
        else summary.errors.push(posted.error);
      } else {
        summary.awaitingApproval++;
      }
    } catch (err) {
      summary.errors.push(`review ${review.id}: ${(err as Error).message}`);
    }
  }
  return summary;
}

/**
 * Best-effort link from a public review to a stay: same first name (and last initial when shown),
 * checked out within 21 days before the review, and exactly one candidate. No match is fine.
 */
export async function matchStay(db: Db, property: Property, author: string | null, reviewedAt: Date): Promise<string | null> {
  const first = firstName(author);
  if (!first) return null;
  const lastInitial = author!.trim().split(/\s+/)[1]?.[0] ?? null;
  const rows = await db.query<{ id: string; guest_last_name: string | null }>(
    `select id::text, guest_last_name from stays
      where property_id = $1 and status = 'checked_out' and lower(guest_first_name) = lower($2)
        and departure_date between ($3::date - 21) and $3::date`,
    [property.id, first, DateTime.fromJSDate(reviewedAt).setZone(property.timezone).toISODate()],
  );
  const candidates = lastInitial
    ? rows.filter((r) => r.guest_last_name?.[0]?.toLowerCase() === lastInitial.toLowerCase())
    : rows;
  return candidates.length === 1 ? candidates[0]!.id : null;
}

async function recoveryNotes(db: Db, stayId: string): Promise<string[]> {
  const rows = await db.query<{ summary: string; resolution: string | null; resolved_at: Date | null }>(
    "select summary, resolution, resolved_at from recovery_cases where stay_id = $1 order by opened_at",
    [stayId],
  );
  return rows.map((r) =>
    r.resolved_at ? `Issue: ${r.summary}. Resolved: ${r.resolution ?? "yes"}.` : `Issue: ${r.summary}. Not resolved.`,
  );
}

async function recentEdits(db: Db, propertyId: string) {
  return db.query<{ draft: string; final: string }>(
    `select d.draft, d.final_text as final from reply_drafts d join reviews r on r.id = d.review_id
      where r.property_id = $1 and d.edited and d.status = 'posted'
      order by d.decided_at desc limit 3`,
    [propertyId],
  );
}

export async function postDraft(
  db: Db,
  draftId: string,
  source: ReviewSource,
  property?: Property,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [d] = await db.query<{ text: string; external_id: string; property_id: string }>(
    `select coalesce(d.final_text, d.draft) as text, r.external_id, r.property_id
       from reply_drafts d join reviews r on r.id = d.review_id where d.id = $1`,
    [draftId],
  );
  if (!d) return { ok: false, error: `draft ${draftId} not found` };
  const prop = property ?? (await getProperty(db, d.property_id));
  try {
    await source.postReply(prop, d.external_id, d.text);
    await db.query("update reply_drafts set status = 'posted', posted_at = now(), error = null where id = $1", [draftId]);
    await db.query(
      "update reviews set existing_reply = $2 where id = (select review_id from reply_drafts where id = $1)",
      [draftId, d.text],
    );
    return { ok: true };
  } catch (err) {
    const error = (err as Error).message;
    await db.query("update reply_drafts set status = 'failed', error = $2 where id = $1", [draftId, error]);
    return { ok: false, error };
  }
}

export async function approveDraft(db: Db, source: ReviewSource, draftId: string, text: string, approver: string) {
  const clean = text.trim();
  if (!clean) throw new Error("reply text is empty");
  const [d] = await db.query<{ id: string }>(
    `update reply_drafts set final_text = $2, edited = (draft <> $2), status = 'approved',
            decided_by = $3, decided_at = now()
      where id = $1 and status in ('pending', 'failed') returning id::text`,
    [draftId, clean, approver],
  );
  if (!d) throw new Error("draft is not awaiting approval");
  return postDraft(db, draftId, source);
}

export async function dismissDraft(db: Db, draftId: string, approver: string) {
  await db.query(
    "update reply_drafts set status = 'dismissed', decided_by = $2, decided_at = now() where id = $1 and status in ('pending', 'failed')",
    [draftId, approver],
  );
}
