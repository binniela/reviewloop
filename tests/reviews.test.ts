import { describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { cleanDraft, TemplateDrafter, type DraftContext, type ReplyDrafter } from "../src/reviews/drafter.js";
import { MockReviewSource, type SourceReview } from "../src/reviews/sources.js";
import { approveDraft, decide, dismissDraft, syncReviews } from "../src/reviews/sync.js";
import { parseAsiReport } from "../src/ingest/asiReport.js";
import { reconcile } from "../src/ingest/reconcile.js";
import { DEPARTURES_CSV, testDb } from "./helpers.js";

const NOW = () => new Date("2026-10-15T18:00:00Z");

const review = (id: string, rating: number, body: string, author = "Guest", reviewedAt = "2026-10-14T15:00:00Z"): SourceReview => ({
  externalId: `accounts/1/locations/2/reviews/${id}`,
  author,
  rating,
  body,
  reviewedAt,
  existingReply: null,
});

class RecordingDrafter implements ReplyDrafter {
  calls: DraftContext[] = [];
  async draft(ctx: DraftContext) {
    this.calls.push(ctx);
    return `Reply to ${ctx.review.author}`;
  }
}

async function drafts(db: Db) {
  return db.query<{ external_id: string; status: string; decided_by: string | null; final_text: string | null; edited: boolean }>(
    `select r.external_id, d.status, d.decided_by, d.final_text, d.edited
       from reply_drafts d join reviews r on r.id = d.review_id order by r.external_id`,
  );
}

describe("decide", () => {
  it("auto-posts 4 and 5 stars when explicitly enabled and routes the rest to a person", () => {
    expect(decide("auto_high", 5, "Great stay").decision).toBe("auto");
    expect(decide("auto_high", 4, null).decision).toBe("auto");
    expect(decide("auto_high", 3, "Fine").decision).toBe("approval");
    expect(decide("auto_high", null, null).decision).toBe("approval");
    expect(decide("approval_all", 5, "Great").decision).toBe("approval");
    expect(decide("auto_all", 1, "Terrible").decision).toBe("auto");
  });

  it("always routes sensitive topics to a person, even 5 stars in auto_all", () => {
    expect(decide("auto_all", 5, "Lovely staff but we found bed bugs")).toEqual({ decision: "approval", reason: "sensitive topic" });
    expect(decide("auto_high", 4, "Had to call the police on the neighbors").decision).toBe("approval");
  });
});

describe("syncReviews", () => {
  it("reconciles interrupted approved posts and surfaces unknown outcomes", async () => {
    const db = await testDb();
    const source = new MockReviewSource({ sunset: [review("sent", 3, "Fine"), review("unknown", 3, "Okay")] });
    await syncReviews(db, "sunset", { source, drafter: new RecordingDrafter(), now: NOW });
    await db.query("update reply_drafts set status = 'approved', decided_at = $1", ["2026-10-15T17:00:00Z"]);
    source.reviews.sunset![0]!.existingReply = "Reply to Guest";
    await syncReviews(db, "sunset", { source, drafter: new RecordingDrafter(), now: NOW });
    const rows = await db.query<{ external_id: string; status: string; error: string | null }>(
      "select r.external_id, d.status, d.error from reply_drafts d join reviews r on r.id = d.review_id order by r.external_id");
    expect(rows.map(r => [r.external_id.split("/").pop(), r.status])).toEqual([["sent", "posted"], ["unknown", "failed"]]);
    expect(rows[1]!.error).toContain("Check Google");
    await db.close();
  });
  it("drafts new reviews, auto-posts high ratings, queues the rest, and is idempotent", async () => {
    const db = await testDb();
    await db.query("update properties set reply_mode = 'auto_high'");
    const source = new MockReviewSource({
      sunset: [
        review("a", 5, "Clean and quiet", "Dana R"),
        review("b", 2, "Room smelled like smoke", "Eli K"),
        review("old", 1, "Bad", "Old Timer", "2026-07-01T00:00:00Z"), // outside the draft window
      ],
    });
    const drafter = new RecordingDrafter();

    const s = await syncReviews(db, "sunset", { source, drafter, now: NOW });
    expect(s).toMatchObject({ fetched: 3, newReviews: 3, drafted: 2, autoPosted: 1, awaitingApproval: 1, errors: [] });
    expect(source.replies).toEqual([{ externalId: "accounts/1/locations/2/reviews/a", text: "Reply to Dana R" }]);
    expect((await drafts(db)).map((d) => [d.external_id.split("/").pop(), d.status, d.decided_by])).toEqual([
      ["a", "posted", "auto"],
      ["b", "pending", null],
    ]);

    const again = await syncReviews(db, "sunset", { source, drafter, now: NOW });
    expect(again).toMatchObject({ newReviews: 0, drafted: 0 });
    expect(drafter.calls).toHaveLength(2);
  });

  it("posts the approver's edited text and feeds edits back as voice examples", async () => {
    const db = await testDb();
    const source = new MockReviewSource({ sunset: [review("b", 2, "Smelled like smoke", "Eli K")] });
    const drafter = new RecordingDrafter();
    await syncReviews(db, "sunset", { source, drafter, now: NOW });
    const [{ id }] = (await db.query<{ id: string }>("select id::text from reply_drafts")) as [{ id: string }];

    const res = await approveDraft(db, source, id, "Eli, sorry about the smell. We deep-cleaned that room. Raj", "raj");
    expect(res).toEqual({ ok: true });
    const [d] = await drafts(db);
    expect(d).toMatchObject({ status: "posted", decided_by: "raj", edited: true });
    await expect(approveDraft(db, source, id, "again", "raj")).rejects.toThrow(/not awaiting approval/);

    source.reviews.sunset!.push(review("c", 5, "Great", "Fay L"));
    await syncReviews(db, "sunset", { source, drafter, now: NOW });
    expect(drafter.calls.at(-1)!.voiceExamples).toEqual([
      { draft: "Reply to Eli K", final: "Eli, sorry about the smell. We deep-cleaned that room. Raj" },
    ]);
  });

  it("keeps heuristic stay matches out of private drafting context", async () => {
    const db = await testDb();
    await reconcile(
      db,
      "sunset",
      parseAsiReport(DEPARTURES_CSV, { kind: "departures", timezone: "America/Los_Angeles" }).reservations,
      new Date("2026-10-13T19:00:00Z"),
    );
    await db.query(
      `insert into recovery_cases (stay_id, summary, resolution, resolved_at)
       select id, 'AC loud', 'Moved to room 112', now() from stays where confirmation = '10001'`,
    );
    const source = new MockReviewSource({ sunset: [review("p", 3, "AC was noisy at first", "Anita P")] });
    const drafter = new RecordingDrafter();
    await syncReviews(db, "sunset", { source, drafter, now: NOW });
    expect(drafter.calls[0]!.stayNotes).toEqual([]);
    const [r] = await db.query<{ confirmation: string }>(
      "select s.confirmation from reviews r join stays s on s.id = r.stay_id",
    );
    expect(r!.confirmation).toBe("10001");
  });

  it("retires a pending draft if someone replies directly on Google", async () => {
    const db = await testDb();
    const source = new MockReviewSource({ sunset: [review("b", 2, "Meh", "Eli K")] });
    await syncReviews(db, "sunset", { source, drafter: new RecordingDrafter(), now: NOW });
    source.reviews.sunset![0]!.existingReply = "Typed by the owner on Google";
    await syncReviews(db, "sunset", { source, drafter: new RecordingDrafter(), now: NOW });
    expect((await drafts(db))[0]).toMatchObject({ status: "dismissed", decided_by: "replied outside app" });
  });

  it("marks failed posts so they can be retried from the queue, and supports dismiss", async () => {
    const db = await testDb();
    const source = new MockReviewSource({ sunset: [review("a", 5, "Nice", "Dana R"), review("b", 1, "Bad", "Eli K")] });
    await db.query("update properties set reply_mode = 'auto_high'");
    source.failNextPost = "Google reply 503";
    const s = await syncReviews(db, "sunset", { source, drafter: new RecordingDrafter(), now: NOW });
    expect(s.errors).toEqual(["Google reply 503"]);
    const failed = await db.query<{ id: string }>("select id::text from reply_drafts where status = 'failed'");
    expect(await approveDraft(db, source, failed[0]!.id, "Thanks Dana!", "raj")).toEqual({ ok: true });

    const pending = await db.query<{ id: string }>("select id::text from reply_drafts where status = 'pending'");
    await dismissDraft(db, pending[0]!.id, "raj");
    expect((await drafts(db)).map((d) => d.status)).toEqual(["posted", "dismissed"]);
  });
});

describe("drafters", () => {
  it("template drafter covers each rating band and signs off", async () => {
    const t = new TemplateDrafter();
    const ctx = (rating: number): DraftContext => ({
      property: { name: "Sunset Inn", voice_notes: "", signoff: "Raj" },
      review: { author: "Dana R", rating, body: "x" },
      stayNotes: [],
      voiceExamples: [],
    });
    expect(await t.draft(ctx(5))).toMatch(/^Thank you, Dana\. We're glad.*\nRaj$/s);
    expect(await t.draft(ctx(1))).toMatch(/sorry/);
  });

  it("cleanDraft strips wrapping quotes and dashes", () => {
    expect(cleanDraft('"Thanks — see you soon"')).toBe("Thanks, see you soon");
  });
});
