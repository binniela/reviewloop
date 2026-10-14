import { html, raw } from "hono/html";
import type { Db } from "../db.js";
import { icon, layout, timeAgo, type Flash } from "./layout.js";
import { reportFreshness } from "./operations.js";

/**
 * Guest issues: a two-pane inbox. The queue (open issues, then other recent texts) on the left,
 * the selected conversation with its actions on the right. On phones the queue and the
 * conversation are separate screens. Server-rendered; selection lives in ?id=.
 */

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
  nights: number | null;
  kind: string;
}

interface MsgRow {
  stay_id: string;
  direction: string;
  kind: string;
  body: string;
  created_at: Date;
  delivery: string | null;
}

const KIND_LABEL: Record<string, string> = {
  ack: "Automatic reply",
  request_ack: "Automatic reply",
  followup: "Automatic follow-up",
  welcome: "Welcome text",
  mid_stay: "Check-in text",
  review_request: "Review request",
  staff: "Front desk",
};

const CATEGORY_LABEL: Record<string, string> = {
  safety: "Safety",
  cleanliness: "Cleanliness",
  maintenance: "Maintenance",
  noise: "Noise",
  billing: "Billing",
  request: "Request",
  question: "Question",
  praise: "Praise",
  other: "Other",
};
const category = (c: string | null) => (c ? (CATEGORY_LABEL[c] ?? c) : null);
/** Staff usernames are stored as typed at sign-in ("maria"); show them as names. */
const phone = (p: string) => {
  const m = p.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : p;
};
const who = (name: string | null) => (name ? name.charAt(0).toUpperCase() + name.slice(1) : "Staff");

export interface IssuesView {
  selected?: string;
  flash?: Flash;
  /** Re-render after a failed send, keeping what they typed. */
  draft?: { caseId: string; text: string; error: string };
}

export async function issuesPage(db: Db, now: Date, view: IssuesView = {}) {
  const open = await db.query<CaseRow>(
    `select c.id::text, c.stay_id::text, c.summary, c.source, c.category, c.urgency, c.opened_at, c.acknowledged_at,
            c.acknowledged_by, c.escalated_at, c.reopened_count, s.confirmation, s.room, s.satisfaction,
            (s.departure_date - s.arrival_date) as nights, c.kind,
            concat_ws(' ', s.guest_first_name, s.guest_last_name) as guest, p.name as property
       from recovery_cases c join stays s on s.id = c.stay_id join properties p on p.id = s.property_id
      where c.resolved_at is null
      order by (c.urgency = 'urgent') desc, (c.acknowledged_at is null) desc, c.opened_at`,
  );
  const current = open.find((o) => o.id === view.selected) ?? (view.selected ? undefined : open[0]);
  const thread = current
    ? await db.query<MsgRow>(
        `select m.stay_id::text, m.direction, m.kind, m.body, m.created_at, r.status as delivery
           from messages m left join sms_delivery_receipts r on r.provider_id = m.provider_id
          where m.stay_id = $1 and m.kind <> 'alert' order by m.created_at`,
        [current.stay_id],
      )
    : [];
  // Requests and texts not tied to an issue, so nothing a guest sends goes unseen.
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
    `select s.id::text, concat(p.name, ' · Room ', coalesce(s.room, '?'), ' · ', concat_ws(' ', s.guest_first_name, s.guest_last_name)) as label
       from stays s join properties p on p.id = s.property_id
      where s.status = 'in_house' or (s.status = 'checked_out' and s.departure_date >= $1::date - 2)
      order by p.name, s.room`,
    [now.toISOString().slice(0, 10)],
  );
  // Check-in QR sign-ups wait for someone at the desk to confirm the guest in person.
  const signups = await db.query<{ id: string; last_name: string; room: string; phone: string; created_at: Date; property: string }>(
    `select c.id::text, c.last_name, c.room, c.phone, c.created_at, p.name as property
       from consents c join properties p on p.id = c.property_id
      where c.approved_at is null and c.created_at > $1::timestamptz - interval '2 days' order by c.created_at`,
    [now.toISOString()],
  );
  const undelivered = await db.query<{ n: number }>(
    `select count(*)::int as n from sms_delivery_receipts where status in ('failed', 'undelivered') and updated_at > $1::timestamptz - interval '24 hours'`,
    [now.toISOString()],
  );
  const stale = (await reportFreshness(db, now)).filter((f) => f.stale);
  const unacked = open.filter((o) => !o.acknowledged_at).length;
  const urgent = open.filter((o) => o.urgency === "urgent").length;
  const failed = undelivered[0]?.n ?? 0;

  const row = (o: CaseRow) => html`<a class="q-row ${o.id === current?.id ? "on" : ""} ${o.urgency === "urgent" ? "hot" : ""}" href="/issues?id=${o.id}">
    <span class="q-top"><strong>${o.guest || "Guest"}</strong><time>${timeAgo(o.opened_at, now)}</time></span>
    <span class="q-meta">Room ${o.room ?? "?"} · ${o.property}</span>
    <span class="q-sum">${o.summary}</span>
    <span class="q-tags">
      ${o.urgency === "urgent" ? html`<span class="tag err">Urgent</span>` : ""}
      ${o.kind === "request" ? html`<span class="tag">Request</span>` : ""}
      ${o.acknowledged_at ? html`<span class="tag good">${who(o.acknowledged_by)} on it</span>` : html`<span class="tag err">Nobody on it</span>`}
      ${o.escalated_at ? html`<span class="tag">GM alerted</span>` : ""}
      ${o.reopened_count ? html`<span class="tag err">Reopened</span>` : ""}
    </span>
  </a>`;

  const pane = current
    ? html`<section class="pane" aria-label="Conversation with ${current.guest || "guest"}">
        <header class="pane-head">
          <a class="back" href="/issues?list=1">${raw("&larr;")} All issues</a>
          <div>
            <strong>${current.guest || "Guest"}</strong>
            <span class="muted">Room ${current.room ?? "?"} · ${current.property}${current.nights ? ` · ${current.nights} night${current.nights === 1 ? "" : "s"}` : ""}</span>
          </div>
          <div class="pane-tags">
            ${current.urgency === "urgent" ? html`<span class="tag err">Urgent</span>` : ""}
            ${category(current.category) ? html`<span class="tag">${category(current.category)}</span>` : ""}
            ${current.acknowledged_at
              ? html`<span class="tag good">${who(current.acknowledged_by)} on it</span>`
              : html`<span class="tag err">Nobody on it yet</span>`}
            ${current.escalated_at ? html`<span class="tag">GM alerted</span>` : ""}
          </div>
        </header>
        <div class="pane-body" id="thread">
          <p class="pane-title">${current.summary}</p>
          <p class="muted small">
            Opened ${timeAgo(current.opened_at, now)} ${current.source === "staff" ? "by staff" : "from a guest text"}${current.acknowledged_at
              ? ` · taken by ${who(current.acknowledged_by)} ${timeAgo(current.acknowledged_at, now)}`
              : ""}
          </p>
          <div class="thread">
            ${thread.map(
              (m) => html`<div class="msg ${m.direction} ${m.delivery === "failed" || m.delivery === "undelivered" ? "failed" : ""}">
                ${m.body}<small>${m.direction === "in" ? "Guest" : (KIND_LABEL[m.kind] ?? m.kind)} · ${timeAgo(m.created_at, now)}${m.delivery === "failed" || m.delivery === "undelivered"
                  ? html` · <b>Not delivered</b>`
                  : ""}</small>
              </div>`,
            )}
          </div>
        </div>
        <footer class="composer">
          ${view.draft && view.draft.caseId === current.id ? html`<p class="err small" role="alert">${view.draft.error}</p>` : ""}
          <form method="post" action="/issues/${current.id}/reply" class="compose" data-guard>
            <textarea name="text" rows="2" placeholder="Text ${(current.guest || "the guest").split(" ")[0]}…" required>${view.draft && view.draft.caseId === current.id ? view.draft.text : ""}</textarea>
            <button type="submit" class="secondary">Send</button>
          </form>
          <div class="pane-actions">
            ${current.acknowledged_at
              ? html`<form method="post" action="/issues/${current.id}/resolve" class="resolve" data-guard>
                  <input name="resolution" placeholder="How was it fixed? (only staff see this)" required />
                  <button type="submit">Resolve</button>
                </form>`
              : html`<form method="post" action="/issues/${current.id}/ack">
                    <button type="submit">I’m on it</button>
                  </form>
                  <span class="muted small">Take it to stop the GM alert. You can resolve it after.</span>`}
          </div>
        </footer>
      </section>`
    : html`<section class="pane pane-empty">
        <div>
          <p class="pane-title">${open.length ? "Pick an issue" : "All clear."}</p>
          <p class="muted">${open.length ? "Choose one from the list to see the conversation." : "No open issues. When a guest texts about a problem, it appears here and the desk is alerted."}</p>
        </div>
      </section>`;

  const body = html`
    <div class="workbar">
      <span class="chip ${unacked ? "hot" : ""}"><b>${unacked}</b> nobody on it</span>
      <span class="chip ${urgent ? "hot" : ""}"><b>${urgent}</b> urgent</span>
      <span class="chip"><b>${open.length}</b> open</span>
      <span class="spacer"></span>
      <details class="log">
        <summary class="btn secondary">Log an issue</summary>
        <form method="post" action="/issues" class="pop" data-guard>
          <p class="pop-title">Something a guest told you in person</p>
          <label>Guest
            <select name="stay" required>
              <option value="" selected disabled>Choose a guest</option>
              ${guests.map((g) => html`<option value="${g.id}">${g.label}</option>`)}
            </select>
          </label>
          <label>What’s wrong <input name="summary" required placeholder="e.g. AC not cooling" /></label>
          <button type="submit">Log issue</button>
        </form>
      </details>
    </div>

    ${signups.length
      ? html`<section class="notice">
          <div class="notice-head">${icon("qr")}<strong>${signups.length} check-in sign-up${signups.length === 1 ? "" : "s"} to confirm</strong>
            <span class="muted">Confirm the guest is at the desk and the phone is theirs before they get texts.</span></div>
          ${signups.map(
            (s) => html`<form method="post" action="/consents/${s.id}/approve" class="notice-row">
              <span><strong>${s.last_name}</strong> · Room ${s.room} · ${s.property}</span>
              <span class="muted">${phone(s.phone)} · ${timeAgo(s.created_at, now)}</span>
              <label class="check"><input type="checkbox" name="verified" value="1" required /> Checked in person</label>
              <button type="submit" class="secondary">Connect</button>
            </form>`,
          )}
        </section>`
      : ""}
    ${failed
      ? html`<p class="notice warn" role="status">
          <strong>${failed} text${failed === 1 ? "" : "s"} didn’t reach guests in the last day.</strong>
          <span class="muted">They’re marked “Not delivered” in each conversation. Call the room if it matters.</span>
        </p>`
      : ""}

    ${stale.length
      ? html`<p class="notice fresh-note" role="status">
          ${icon("upload")}<strong>Today’s reports aren’t in for ${stale.map((f) => f.name).join(" and ")}.</strong>
          <span class="muted">Welcome texts and review requests wait on them.</span>
          <a class="btn secondary" href="/upload">Upload</a>
        </p>`
      : ""}

    <div class="inbox ${view.selected ? "has-sel" : ""}">
      <nav class="queue" aria-label="Open issues">
        ${open.length ? html`<p class="q-label">Open · ${open.length}</p>${open.map(row)}` : html`<p class="q-empty">No open issues.</p>`}
        ${recent.length
          ? html`<p class="q-label">Other texts · 24 h</p>
              ${recent.map(
                (m) => html`<div class="q-row quiet">
                  <span class="q-top"><strong>${m.guest || m.from_addr}</strong><time>${timeAgo(m.created_at, now)}</time></span>
                  <span class="q-meta">${m.room ? `Room ${m.room} · ` : ""}${m.property}${category(m.category) ? ` · ${category(m.category)}` : ""}</span>
                  <span class="q-sum">${m.body}</span>
                </div>`,
              )}`
          : ""}
      </nav>
      ${pane}
    </div>
  `;

  return layout("Guest issues", body, {
    head: html`<script>${raw(liveScript(unacked))}</script>`,
    active: "/issues",
    wide: true,
    flash: view.flash,
  });
}

// Keeps the page current without losing work: when anything changes, reload only if nobody is
// typing; otherwise offer a refresh. Chimes when a new issue arrives, so a desk with only a
// landline can leave this page open as its alert.
function liveScript(unacked: number) {
  return `
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

  document.addEventListener("DOMContentLoaded", function () {
    var t = document.getElementById("thread");
    if (t) t.scrollTop = t.scrollHeight;
    var busy = function () {
      var a = document.activeElement;
      if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return true;
      return Array.prototype.some.call(document.querySelectorAll("[data-guard] textarea, [data-guard] input:not([type=checkbox])"), function (el) { return el.value.trim() !== ""; })
        || !!document.querySelector("details.log[open]");
    };
    var seen = null;
    function check() {
      fetch("/api/status", { headers: { accept: "application/json" }, credentials: "same-origin" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (s) {
          if (!s) return;
          var sig = [s.unacked, s.open, s.lastActivity, s.signups].join("|");
          if (seen === null) { seen = sig; return; }
          if (sig === seen) return;
          seen = sig;
          if (!busy()) return location.reload();
          var pill = document.getElementById("rl-fresh");
          if (pill) pill.hidden = false;
        })
        .catch(function () {});
    }
    setInterval(check, 15000);
    check();
  });
})();`;
}
