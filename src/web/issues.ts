import { html } from "hono/html";
import type { Db } from "../db.js";
import { layout, timeAgo } from "./layout.js";

interface CaseRow {
  id: string;
  stay_id: string;
  summary: string;
  source: string;
  category: string | null;
  urgency: string;
  opened_at: Date;
  acknowledged_at: Date | null;
  acknowledged_by: string | null;
  escalated_at: Date | null;
  reopened_count: number;
  guest: string;
  room: string | null;
  confirmation: string;
  property: string;
  satisfaction: number | null;
}

interface MsgRow {
  stay_id: string;
  direction: string;
  kind: string;
  body: string;
  created_at: Date;
}

export async function issuesPage(db: Db, now: Date) {
  const open = await db.query<CaseRow>(
    `select c.id::text, c.stay_id::text, c.summary, c.source, c.category, c.urgency, c.opened_at, c.acknowledged_at,
            c.acknowledged_by, c.escalated_at, c.reopened_count, s.confirmation, s.room, s.satisfaction,
            concat_ws(' ', s.guest_first_name, s.guest_last_name) as guest, p.name as property
       from recovery_cases c join stays s on s.id = c.stay_id join properties p on p.id = s.property_id
      where c.resolved_at is null
      order by (c.urgency = 'urgent') desc, (c.acknowledged_at is null) desc, c.opened_at`,
  );
  const threads = open.length
    ? await db.query<MsgRow>(
        `select stay_id::text, direction, kind, body, created_at from messages
          where stay_id = any($1::bigint[]) and kind <> 'alert' order by created_at`,
        [open.map((o) => o.stay_id)],
      )
    : [];
  // Requests and texts we couldn't tie to an issue, so nothing a guest sends goes unseen.
  const recent = await db.query<{ body: string; from_addr: string; created_at: Date; guest: string | null; room: string | null; property: string; category: string | null }>(
    `select m.body, m.from_addr, m.created_at, concat_ws(' ', s.guest_first_name, s.guest_last_name) as guest, s.room,
            p.name as property, m.classification->>'category' as category
       from messages m join properties p on p.id = m.property_id left join stays s on s.id = m.stay_id
      where m.direction = 'in' and m.kind = 'inbound' and m.case_id is null
        and m.created_at > $1::timestamptz - interval '24 hours'
      order by m.created_at desc limit 30`,
    [now.toISOString()],
  );
  const guests = await db.query<{ id: string; label: string }>(
    `select s.id::text, concat(p.name, ' · ', coalesce(s.room, '?'), ' · ', concat_ws(' ', s.guest_first_name, s.guest_last_name),
                              ' (', s.confirmation, ')') as label
       from stays s join properties p on p.id = s.property_id
      where s.status = 'in_house' or (s.status = 'checked_out' and s.departure_date >= $1::date - 2)
      order by p.name, s.room`,
    [now.toISOString().slice(0, 10)],
  );
  const unacked = open.filter((o) => !o.acknowledged_at).length;

  // Refreshes every 30s; chimes when the number of unacknowledged issues goes up. Lets a desk
  // with only a landline leave this page open as its alert.
  const head = html`<meta http-equiv="refresh" content="30" />
    <script>
      (function () {
        var n = ${unacked}, key = "rl_unacked";
        try {
          var prev = Number(sessionStorage.getItem(key) || 0);
          sessionStorage.setItem(key, String(n));
          if (n > prev) {
            var ctx = new (window.AudioContext || window.webkitAudioContext)();
            [0, 0.25].forEach(function (t) {
              var o = ctx.createOscillator(), g = ctx.createGain();
              o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
              g.gain.setValueAtTime(0.2, ctx.currentTime + t); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.2);
              o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.2);
            });
          }
        } catch (e) {}
        if (n > 0) document.title = "(" + n + ") " + document.title;
      })();
    </script>`;

  return layout(
    "Guest issues",
    html`
      ${open.length === 0 ? html`<p class="empty">No open issues. Guest texts that need attention show up here automatically.</p>` : ""}
      ${open.map((o) => {
        const thread = threads.filter((t) => t.stay_id === o.stay_id).slice(-8);
        return html`
          <article class="card ${o.urgency === "urgent" ? "urgent" : ""}">
            <header>
              <strong>${o.guest || "Guest"}</strong> · Room ${o.room ?? "?"} · ${o.property} · ${timeAgo(o.opened_at, now)}
              ${o.urgency === "urgent" ? html`<span class="tag err">Urgent</span>` : ""}
              ${o.category ? html`<span class="tag">${o.category}</span>` : ""}
              ${o.reopened_count ? html`<span class="tag err">Reopened</span>` : ""}
              ${o.acknowledged_at
                ? html`<span class="tag good">${o.acknowledged_by ?? "staff"} on it</span>`
                : html`<span class="tag err">Nobody on it yet</span>`}
              ${o.escalated_at ? html`<span class="tag">GM alerted</span>` : ""}
            </header>
            <p><strong>${o.summary}</strong></p>
            ${thread.length
              ? html`<div class="thread">
                  ${thread.map(
                    (m) => html`<div class="msg ${m.direction}">${m.body}<small>${m.direction === "in" ? "Guest" : m.kind} · ${timeAgo(m.created_at, now)}</small></div>`,
                  )}
                </div>`
              : ""}
            <div class="actions">
              ${o.acknowledged_at ? "" : html`<form method="post" action="/issues/${o.id}/ack"><button type="submit">I'm on it</button></form>`}
            </div>
            <form method="post" action="/issues/${o.id}/reply" class="inline">
              <input name="text" placeholder="Text the guest" required />
              <button type="submit" class="secondary">Send</button>
            </form>
            <form method="post" action="/issues/${o.id}/resolve" class="inline">
              <input name="resolution" placeholder="How it was fixed (private)" required />
              <button type="submit">Resolve</button>
            </form>
          </article>
        `;
      })}
      ${recent.length
        ? html`<h2>Other guest texts, last 24 hours</h2>
            ${recent.map(
              (m) => html`<div class="card">
                <header>
                  <strong>${m.guest || m.from_addr}</strong>${m.room ? ` · Room ${m.room}` : ""} · ${m.property} · ${timeAgo(m.created_at, now)}
                  ${m.category ? html`<span class="tag">${m.category}</span>` : ""}
                </header>
                <p>${m.body}</p>
              </div>`,
            )}`
        : ""}
      <h2>Log an issue someone reported in person</h2>
      <form method="post" action="/issues" class="card">
        <label>Guest <select name="stay">${guests.map((g) => html`<option value="${g.id}">${g.label}</option>`)}</select></label>
        <label>What's wrong <input name="summary" required placeholder="AC not cooling" /></label>
        <button type="submit">Log issue</button>
      </form>
    `,
    { head },
  );
}
