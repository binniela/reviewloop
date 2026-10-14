import type { Db } from "../db.js";
import { listProperties } from "../properties.js";

/**
 * Ask Reviewloop: quick answers computed from live data, no language model involved, so they're
 * instant, work offline and never invent anything. Free-text questions are matched to a topic.
 */

export type Topic = "complaints" | "risk" | "reviews";

export interface Answer {
  title: string;
  lead: string;
  bars?: { label: string; value: number }[];
  items?: { text: string; href?: string }[];
  followups: { topic: Topic; label: string }[];
}

const LABEL: Record<Topic, string> = {
  complaints: "What are guests complaining about?",
  risk: "Which issues are about to reach the GM?",
  reviews: "How are reviews doing?",
};
const CATEGORY: Record<string, string> = {
  safety: "Safety", cleanliness: "Cleanliness", maintenance: "Maintenance", noise: "Noise", billing: "Billing",
  request: "Requests", question: "Questions", other: "Other",
};

export function topicFor(q: string): Topic | null {
  const t = q.toLowerCase();
  if (/review|rating|star|google|repl/.test(t)) return "reviews";
  if (/escalat|gm|manager|waiting|late|overdue|nobody|urgent|about to/.test(t)) return "risk";
  if (/complain|issue|problem|common|wrong|broken|category|trend/.test(t)) return "complaints";
  return null;
}

const others = (t: Topic) => (Object.keys(LABEL) as Topic[]).filter((x) => x !== t).map((x) => ({ topic: x, label: LABEL[x] }));

export async function answer(db: Db, now: Date, topic: Topic | null): Promise<Answer> {
  if (!topic) {
    return {
      title: "I can answer three things for now",
      lead: "What guests are complaining about, which issues are close to reaching the GM, and how reviews are doing.",
      followups: (Object.keys(LABEL) as Topic[]).map((x) => ({ topic: x, label: LABEL[x] })),
    };
  }

  if (topic === "complaints") {
    const rows = await db.query<{ category: string | null; n: number }>(
      `select coalesce(category, 'other') as category, count(*)::int as n from recovery_cases
        where opened_at > $1::timestamptz - interval '7 days' group by 1 order by n desc, 1`,
      [now.toISOString()],
    );
    const total = rows.reduce((a, r) => a + r.n, 0);
    if (!total) return { title: "No issues in the last 7 days", lead: "Nothing guests reported needed fixing this week.", followups: others(topic) };
    const top = rows[0]!;
    return {
      title: "Issues by type, last 7 days",
      lead: `${total} issue${total === 1 ? "" : "s"} this week. ${CATEGORY[top.category ?? "other"] ?? top.category} leads with ${top.n}.`,
      bars: rows.map((r) => ({ label: CATEGORY[r.category ?? "other"] ?? r.category ?? "Other", value: r.n })),
      followups: others(topic),
    };
  }

  if (topic === "risk") {
    const props = new Map((await listProperties(db)).map((p) => [p.id, p]));
    const rows = await db.query<{ id: string; summary: string; guest: string; room: string | null; property_id: string; opened_at: Date; escalated_at: Date | null; urgency: string }>(
      `select c.id::text, c.summary, concat_ws(' ', s.guest_first_name, s.guest_last_name) as guest, s.room, s.property_id,
              c.opened_at, c.escalated_at, c.urgency
         from recovery_cases c join stays s on s.id = c.stay_id
        where c.resolved_at is null and c.acknowledged_at is null order by c.opened_at`,
    );
    if (!rows.length) return { title: "Nothing is waiting", lead: "Every open issue has someone on it. The GM won’t be texted.", followups: others(topic) };
    const items = rows.map((r) => {
      const limit = props.get(r.property_id)?.escalation_minutes ?? 20;
      const left = Math.ceil(limit - (now.getTime() - new Date(r.opened_at).getTime()) / 60_000);
      const when = r.escalated_at ? "GM already texted" : left <= 0 ? "GM text due now" : `GM texted in ${left} min`;
      return { text: `${r.guest || "Guest"}${r.room ? `, room ${r.room}` : ""}: ${r.summary} · ${when}`, href: `/issues?id=${r.id}`, left: r.escalated_at ? -999 : left };
    });
    items.sort((a, b) => a.left - b.left);
    const already = rows.filter((r) => r.escalated_at).length;
    return {
      title: `${rows.length} issue${rows.length === 1 ? "" : "s"} with nobody on it`,
      lead: already ? `${already} already reached the GM. Tap “I’m on it” on the rest to stop the alert.` : "Tap “I’m on it” to stop the GM alert.",
      items: items.map(({ text, href }) => ({ text, href })),
      followups: others(topic),
    };
  }

  const hotels = await listProperties(db);
  const items: { text: string; href?: string }[] = [];
  for (const p of hotels) {
    const snaps = await db.query<{ review_count: number; avg_rating: number | null }>(
      "select review_count, avg_rating from review_snapshots where property_id = $1 and source = 'google' order by day",
      [p.id],
    );
    const first = snaps[0];
    const last = snaps.at(-1);
    if (!last) {
      items.push({ text: `${p.name}: no Google data yet` });
      continue;
    }
    const delta = first ? last.review_count - first.review_count : 0;
    items.push({
      text: `${p.name}: ${last.avg_rating?.toFixed(2) ?? "?"} stars, ${last.review_count} reviews${delta ? ` (+${delta} since launch)` : ""}`,
    });
  }
  const [w] = await db.query<{ waiting: number; low: number; week: number; avg: number | null }>(
    `select (select count(*)::int from reply_drafts where status in ('pending','failed')) as waiting,
            (select count(*)::int from reply_drafts d join reviews r on r.id = d.review_id where d.status in ('pending','failed') and r.rating <= 3) as low,
            (select count(*)::int from reviews where reviewed_at > $1::timestamptz - interval '7 days') as week,
            (select round(avg(rating)::numeric, 1)::float from reviews where reviewed_at > $1::timestamptz - interval '7 days') as avg`,
    [now.toISOString()],
  );
  if (w?.waiting) items.push({ text: `${w.waiting} repl${w.waiting === 1 ? "y" : "ies"} waiting for approval${w.low ? `, ${w.low} on 3 stars or less` : ""}`, href: "/" });
  return {
    title: "Reviews right now",
    lead: w?.week ? `${w.week} new review${w.week === 1 ? "" : "s"} this week, averaging ${w.avg} stars.` : "No new reviews this week yet.",
    items,
    followups: others("reviews"),
  };
}
