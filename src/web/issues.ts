import { html, raw } from "hono/html";
import type { Db } from "../db.js";
import { listProperties } from "../properties.js";
import { icon, layout, timeAgo, type Flash } from "./layout.js";
import { reportFreshness } from "./operations.js";

/**
 * Guest issues inbox. Filter sidebar (views, hotels), tabs by state (Todo, In progress, Done),
 * search and sort, a list of guests, and the selected conversation in a panel on the right.
 * Server-rendered: every filter is a query parameter, so links and the back button just work.
 */

interface CaseRow {
  id: string;
  stay_id: string;
  property_id: string;
  summary: string;
  source: string;
  category: string | null;
  urgency: string;
  kind: string;
  opened_at: Date;
  acknowledged_at: Date | null;
  acknowledged_by: string | null;
  escalated_at: Date | null;
  resolved_at: Date | null;
  resolution: string | null;
  guest_confirmed_at: Date | null;
  reopened_count: number;
  guest: string;
  room: string | null;
  property: string;
  nights: number | null;
  last_in: string | null;
}

interface MsgRow {
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
const phone = (p: string) => {
  const m = p.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : p;
};
/** Staff usernames are stored as typed at sign-in ("maria"); show them as names. */
const who = (name: string | null) => (name ? name.charAt(0).toUpperCase() + name.slice(1) : "Staff");
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "G";

/** Hotel identity colors, assigned in a fixed order (never by count). */
const HOTEL_COLORS = ["#4C8DF6", "#E2557B", "#E9A23B", "#EF7A3C", "#5DB760", "#8E6CEF"];
/** Soft avatar tints, picked by name so a guest keeps the same one. */
const TINTS = ["#F3E8DA", "#E3EDF7", "#E9F1E4", "#F6E4E8", "#EEE8F6", "#F5EEDC"];
const tint = (name: string) => TINTS[[...name].reduce((a, ch) => a + ch.charCodeAt(0), 0) % TINTS.length]!;

type Tab = "todo" | "followup" | "done";
type View = "all" | "urgent" | "requests" | "texts";

export interface IssuesView {
  selected?: string;
  flash?: Flash;
  /** Re-render after a failed send, keeping what they typed. */
  draft?: { caseId: string; text: string; error: string };
  tab?: string;
  view?: string;
  hotel?: string;
  q?: string;
  sort?: string;
}

export async function issuesPage(db: Db, now: Date, view: IssuesView = {}) {
  const hotels = await listProperties(db);
  const color = new Map(hotels.map((h, i) => [h.id, HOTEL_COLORS[i % HOTEL_COLORS.length]!]));

  const cases = await db.query<CaseRow>(
    `select c.id::text, c.stay_id::text, s.property_id, c.summary, c.source, c.category, c.urgency, c.kind, c.opened_at,
            c.acknowledged_at, c.acknowledged_by, c.escalated_at, c.resolved_at, c.resolution, c.guest_confirmed_at, c.reopened_count, s.room,
            (s.departure_date - s.arrival_date) as nights, concat_ws(' ', s.guest_first_name, s.guest_last_name) as guest,
            p.name as property,
            (select m.body from messages m where m.case_id = c.id and m.direction = 'in' order by m.created_at desc limit 1) as last_in
       from recovery_cases c join stays s on s.id = c.stay_id join properties p on p.id = s.property_id
      where c.resolved_at is null or c.resolved_at > $1::timestamptz - interval '7 days'`,
    [now.toISOString()],
  );
  const open = cases.filter((c) => !c.resolved_at);
  const unacked = open.filter((c) => !c.acknowledged_at).length;

  const tab: Tab = view.tab === "followup" || view.tab === "done" ? view.tab : "todo";
  const v: View = (["urgent", "requests", "texts"] as const).find((x) => x === view.view) ?? "all";
  const hotel = hotels.some((h) => h.id === view.hotel) ? view.hotel! : "";
  const q = (view.q ?? "").trim().toLowerCase();
  const sort = view.sort === "newest" || view.sort === "oldest" ? view.sort : "priority";

  const inScope = (c: CaseRow) =>
    (!hotel || c.property_id === hotel) &&
    (v !== "urgent" || c.urgency === "urgent") &&
    (v !== "requests" || c.kind === "request") &&
    (!q || [c.guest, c.room ?? "", c.summary, c.last_in ?? ""].some((x) => x.toLowerCase().includes(q)));
  // Todo: everything open. Follow up: fixed in the last 48 hours, guest hasn't said it's better yet.
  // Done: confirmed by the guest, or fixed more than 48 hours ago (kept for 7 days).
  const followingUp = (c: CaseRow) => !!c.resolved_at && !c.guest_confirmed_at && now.getTime() - new Date(c.resolved_at).getTime() < 48 * 3_600_000;
  const byTab = (t: Tab) =>
    cases.filter((c) => inScope(c) && (t === "todo" ? !c.resolved_at : t === "followup" ? followingUp(c) : !!c.resolved_at && !followingUp(c)));
  const counts = { todo: byTab("todo").length, followup: byTab("followup").length, done: byTab("done").length };
  const rows = byTab(tab).sort((a, b) => {
    if (sort === "newest") return +new Date(b.opened_at) - +new Date(a.opened_at);
    if (sort === "oldest") return +new Date(a.opened_at) - +new Date(b.opened_at);
    if (tab !== "todo") return +new Date(b.resolved_at!) - +new Date(a.resolved_at!);
    return (
      Number(b.urgency === "urgent") - Number(a.urgency === "urgent") ||
      Number(!b.acknowledged_at) - Number(!a.acknowledged_at) ||
      +new Date(a.opened_at) - +new Date(b.opened_at)
    );
  });

  const current = view.selected ? cases.find((c) => c.id === view.selected) : undefined;
  const thread = current
    ? await db.query<MsgRow>(
        `select m.direction, m.kind, m.body, m.created_at, r.status as delivery
           from messages m left join sms_delivery_receipts r on r.provider_id = m.provider_id
          where m.stay_id = $1 and m.kind <> 'alert' order by m.created_at`,
        [current.stay_id],
      )
    : [];

  // Texts not tied to an issue (requests answered automatically, thanks, questions), so nothing goes unseen.
  const texts = await db.query<{ body: string; from_addr: string; created_at: Date; guest: string | null; room: string | null; property: string; property_id: string; category: string | null }>(
    `select m.body, m.from_addr, m.created_at, concat_ws(' ', s.guest_first_name, s.guest_last_name) as guest, s.room,
            p.name as property, p.id as property_id, m.classification->>'category' as category
       from messages m join properties p on p.id = m.property_id left join stays s on s.id = m.stay_id
      where m.direction = 'in' and m.kind = 'inbound' and m.case_id is null
        and m.created_at > $1::timestamptz - interval '24 hours'
      order by m.created_at desc limit 50`,
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
  const [undelivered] = await db.query<{ n: number }>(
    `select count(*)::int as n from sms_delivery_receipts where status in ('failed', 'undelivered') and updated_at > $1::timestamptz - interval '24 hours'`,
    [now.toISOString()],
  );
  const stale = (await reportFreshness(db, now)).filter((f) => f.stale);
  const failed = undelivered?.n ?? 0;

  // ---- URLs: every control keeps the other filters
  const state = { tab, view: v === "all" ? "" : v, hotel, q: view.q ?? "", sort: sort === "priority" ? "" : sort };
  const url = (patch: Partial<typeof state> & { id?: string }) => {
    const p = new URLSearchParams();
    for (const [k, val] of Object.entries({ ...state, ...patch })) if (val && !(k === "tab" && val === "todo")) p.set(k, String(val));
    const qs = p.toString();
    return `/issues${qs ? `?${qs}` : ""}`;
  };

  // ---- Filter sidebar
  const openIn = (pred: (c: CaseRow) => boolean) => open.filter(pred).length;
  const sn = (href: string, label: string, n: number | null, on: boolean, extra: unknown = "", hot = false) =>
    html`<a class="sn-item ${on ? "on" : ""} ${hot && n ? "hot" : ""}" href="${href}">${extra}<span>${label}</span>${n != null ? html`<b>${n}</b>` : ""}</a>`;
  const subnav = html`
    <p class="sn-title">Guest issues</p>
    ${sn(url({ view: "", hotel: "", id: "" }), "All issues", open.length, v === "all" && !hotel, html`<span class="sn-ico">${icon("issues")}</span>`)}
    ${sn(url({ view: "urgent", id: "" }), "Urgent", openIn((c) => c.urgency === "urgent"), v === "urgent", html`<span class="sn-ico">${icon("alert")}</span>`, true)}
    ${sn(url({ view: "requests", id: "" }), "Requests", openIn((c) => c.kind === "request"), v === "requests", html`<span class="sn-ico">${icon("bag")}</span>`)}
    ${sn(url({ view: "texts", id: "" }), "Other texts", texts.length, v === "texts", html`<span class="sn-ico">${icon("chat")}</span>`)}
    ${hotels.length
      ? html`<p class="sn-label">Hotels</p>
          ${hotels.map((h) =>
            sn(
              url({ hotel: hotel === h.id ? "" : h.id, id: "" }),
              h.name,
              openIn((c) => c.property_id === h.id),
              hotel === h.id,
              html`<span class="sn-dot" style="--c:${color.get(h.id)}"></span>`,
            ),
          )}`
      : ""}
    <p class="sn-label">Shortcuts</p>
    ${sn("/", "Review replies", null, false, html`<span class="sn-ico">${icon("replies")}</span>`)}
    ${sn("/upload", "Upload report", null, false, html`<span class="sn-ico">${icon("upload")}</span>`)}
  `;

  // ---- Rows
  const avatar = (name: string, propertyId: string) =>
    html`<span class="avatar" style="background:${tint(name)}">${initials(name)}<i style="background:${color.get(propertyId)}"></i></span>`;
  const row = (c: CaseRow) => html`<a class="row ${c.id === current?.id ? "on" : ""}" href="${url({ id: c.id })}">
    <span class="unread ${!c.resolved_at && !c.acknowledged_at ? "is" : ""}" aria-hidden="true"></span>
    ${avatar(c.guest || "Guest", c.property_id)}
    <span class="row-main">
      <span class="row-top">
        <strong>${c.guest || "Guest"}</strong><span class="row-room">Room ${c.room ?? "?"}</span>
        ${c.resolved_at
          ? html`<span class="pill ok">${c.guest_confirmed_at ? "Guest says it’s better" : "Fixed"}</span>`
          : html`${c.urgency === "urgent" ? html`<span class="pill err">${icon("alert")}Urgent</span>` : ""}
              ${c.escalated_at && !c.acknowledged_at ? html`<span class="pill err">GM alerted</span>` : ""}
              ${c.kind === "request" ? html`<span class="pill">Request</span>` : ""}
              ${c.reopened_count ? html`<span class="pill err">Reopened</span>` : ""}`}
      </span>
      <span class="row-msg">${c.resolved_at && c.resolution ? `Fixed: ${c.resolution}` : (c.last_in ?? c.summary)}</span>
    </span>
    <span class="row-side">
      <time>${timeAgo(c.resolved_at ?? c.opened_at, now)}</time>
      ${c.resolved_at
        ? html`<span>${who(c.acknowledged_by)}</span>`
        : c.acknowledged_at
          ? html`<span class="owner">${who(c.acknowledged_by)} on it</span>`
          : html`<span class="owner none">Nobody on it yet</span>`}
    </span>
  </a>`;

  const textRow = (m: (typeof texts)[number]) => html`<div class="row quiet">
    <span class="unread" aria-hidden="true"></span>
    ${avatar(m.guest || m.from_addr, m.property_id)}
    <span class="row-main">
      <span class="row-top"><strong>${m.guest || phone(m.from_addr)}</strong>${category(m.category) ? html`<span class="pill">${category(m.category)}</span>` : ""}</span>
      <span class="row-msg">${m.body}</span>
    </span>
    <span class="row-side"><time>${timeAgo(m.created_at, now)}</time><span>${m.room ? `Room ${m.room}` : m.property}</span></span>
  </div>`;

  // ---- Empty states
  const zero = (title: string, text: string) => html`<div class="zero">
    <div class="zero-art" aria-hidden="true"><i></i></div>
    <p class="zero-title">${title}</p>
    <p class="muted">${text}</p>
  </div>`;
  const setup = html`<div class="zero setup">
    <p class="zero-title">Let’s get your hotel set up.</p>
    <p class="muted">Three steps and guest texts start flowing into this inbox.</p>
    <ol class="steps">
      <li class="${hotels.length ? "done" : ""}">
        <b>Add your hotels</b>
        <span>Fill in <code>config/properties.json</code> (start from the example), then run <code>npm run properties -- config/properties.json</code>.</span>
      </li>
      <li><b>Upload today’s reports</b><span>In-house and departures from ASI. <a href="/upload">Upload a report</a></span></li>
      <li><b>Put the QR sign at the desk</b><span>Guests scan it to get texts during their stay. <a href="/setup">Print the sign</a></span></li>
    </ol>
  </div>`;

  let list: unknown;
  const hotelTexts = texts.filter((m) => !hotel || m.property_id === hotel);
  if (!hotels.length) list = setup;
  else if (v === "texts")
    list = hotelTexts.length ? hotelTexts.map(textRow) : zero("No other texts today.", "Thanks, questions and requests that didn’t need an issue show up here.");
  else if (rows.length) list = rows.map(row);
  else if (q) list = zero("No matches.", `Nothing in ${tab === "done" ? "Done" : tab === "followup" ? "Follow up" : "Todo"} matches “${view.q}”.`);
  else if (tab === "todo") list = zero("Inbox zero.", "Nobody is waiting on you. When a guest texts about a problem, it lands here and the desk is alerted.");
  else if (tab === "followup") list = zero("No follow-ups waiting.", "Fixed issues wait here until the guest says it’s better, for up to 48 hours.");
  else list = zero("Nothing resolved this week yet.", "Fixed issues stay here for 7 days.");

  // ---- Conversation panel
  const panel = current
    ? html`<section class="panel" aria-label="Conversation with ${current.guest || "guest"}">
        <header class="pane-head">
          ${avatar(current.guest || "Guest", current.property_id)}
          <div>
            <strong>${current.guest || "Guest"}</strong>
            <span class="muted">Room ${current.room ?? "?"} · ${current.property}${current.nights ? ` · ${current.nights} night${current.nights === 1 ? "" : "s"}` : ""}</span>
          </div>
          <a class="icon-btn" href="${url({ id: "" })}" aria-label="Close conversation">${icon("x")}</a>
        </header>
        <div class="pane-body" id="thread">
          <div class="pane-tags">
            ${current.resolved_at
              ? html`<span class="tag good">Fixed ${timeAgo(current.resolved_at, now)}</span>
                  ${current.guest_confirmed_at ? html`<span class="tag good">Guest says it’s better</span>` : html`<span class="tag">Waiting on the guest</span>`}`
              : html`${current.urgency === "urgent" ? html`<span class="tag err">Urgent</span>` : ""}
                  ${current.acknowledged_at ? html`<span class="tag good">${who(current.acknowledged_by)} on it</span>` : html`<span class="tag err">Nobody on it yet</span>`}
                  ${current.escalated_at ? html`<span class="tag">GM alerted</span>` : ""}`}
            ${category(current.category) ? html`<span class="tag">${category(current.category)}</span>` : ""}
          </div>
          <p class="pane-title">${current.summary}</p>
          <p class="muted small">
            Opened ${timeAgo(current.opened_at, now)} ${current.source === "staff" ? "by staff" : "from a guest text"}${current.acknowledged_at
              ? ` · taken by ${who(current.acknowledged_by)} ${timeAgo(current.acknowledged_at, now)}`
              : ""}
          </p>
          ${current.resolution ? html`<p class="fixnote"><b>How it was fixed</b>${current.resolution}</p>` : ""}
          <div class="thread">
            ${thread.map((m) => {
              const bad = m.delivery === "failed" || m.delivery === "undelivered";
              return html`<div class="msg ${m.direction} ${bad ? "failed" : ""}">
                ${m.body}<small>${m.direction === "in" ? "Guest" : (KIND_LABEL[m.kind] ?? m.kind)} · ${timeAgo(m.created_at, now)}${bad ? html` · <b>Not delivered</b>` : ""}</small>
              </div>`;
            })}
          </div>
        </div>
        ${current.resolved_at
          ? ""
          : html`<footer class="composer">
              ${view.draft && view.draft.caseId === current.id ? html`<p class="err small" role="alert">${view.draft.error}</p>` : ""}
              <form method="post" action="/issues/${current.id}/reply" class="compose" data-guard>
                <textarea name="text" rows="2" placeholder="Text ${(current.guest || "the guest").split(" ")[0]}…" required>${view.draft && view.draft.caseId === current.id ? view.draft.text : ""}</textarea>
                <button type="submit" class="send" aria-label="Send">${icon("send")}</button>
              </form>
              <div class="pane-actions">
                ${current.acknowledged_at
                  ? html`<form method="post" action="/issues/${current.id}/resolve" class="resolve" data-guard>
                      <input name="resolution" placeholder="How was it fixed? (only staff see this)" required />
                      <button type="submit">Resolve</button>
                    </form>`
                  : html`<form method="post" action="/issues/${current.id}/ack"><button type="submit">I’m on it</button></form>
                      <span class="muted small">Take it to stop the GM alert. You can resolve it after.</span>`}
              </div>
            </footer>`}
      </section>`
    : "";

  // ---- Banners that need someone today
  const banners = html`
    ${signups.length
      ? html`<section class="banner">
          <div class="banner-head">${icon("qr")}<strong>${signups.length} check-in sign-up${signups.length === 1 ? "" : "s"} to confirm</strong>
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
      ? html`<p class="banner warn" role="status">${icon("alert")}<strong>${failed} text${failed === 1 ? "" : "s"} didn’t reach guests in the last day.</strong>
          <span class="muted">They’re marked “Not delivered” in each conversation.</span> <a href="/operations">See which</a></p>`
      : ""}
    ${stale.length
      ? html`<p class="banner" role="status">${icon("upload")}<strong>Today’s reports aren’t in for ${stale.map((f) => f.name).join(" and ")}.</strong>
          <span class="muted">Welcome texts and review requests wait on them.</span> <a href="/upload">Upload</a></p>`
      : ""}
  `;

  const tabLink = (t: Tab, label: string) =>
    html`<a class="tab ${tab === t && v !== "texts" ? "on" : ""}" href="${url({ tab: t, view: v === "texts" ? "" : state.view, id: "" })}">${label}<b>${counts[t]}</b></a>`;
  const sortLabel = { priority: "Urgent first", newest: "Newest", oldest: "Oldest" } as const;

  const body = html`
    <div class="tabsbar">
      ${tabLink("todo", "Todo")} ${tabLink("followup", "Follow up")} ${tabLink("done", "Done")}
      <span class="tools">
        <details class="menu">
          <summary class="tool">${icon("sort")}<span>${sortLabel[sort]}</span></summary>
          <div class="menu-pop">
            ${(["priority", "newest", "oldest"] as const).map(
              (s) => html`<a class="${sort === s ? "on" : ""}" href="${url({ sort: s === "priority" ? "" : s, id: "" })}">${sortLabel[s]}</a>`,
            )}
          </div>
        </details>
        <form class="search" method="get" action="/issues" role="search">
          ${icon("search")}
          ${state.tab !== "todo" ? html`<input type="hidden" name="tab" value="${state.tab}" />` : ""}
          ${state.view ? html`<input type="hidden" name="view" value="${state.view}" />` : ""}
          ${hotel ? html`<input type="hidden" name="hotel" value="${hotel}" />` : ""}
          <input name="q" value="${view.q ?? ""}" placeholder="Search guests, rooms, messages" aria-label="Search issues" autocomplete="off" />
          <kbd>/</kbd>
        </form>
      </span>
    </div>
    ${banners}
    <div class="inbox-body ${current ? "has-sel" : ""}">
      <div class="list">${list}</div>
      ${panel}
    </div>
  `;

  const actions = html`
    <details class="log">
      <summary class="btn">${icon("plus")}<span>Log an issue</span></summary>
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
  `;

  return layout("Guest issues", body, {
    head: html`<script>${raw(liveScript(unacked))}</script>`,
    active: "/issues",
    wide: true,
    subnav,
    actions,
    flash: view.flash,
  });
}

// Keeps the page current without losing work: when anything changes, reload only if nobody is
// typing; otherwise offer a refresh. Chimes when a new issue arrives, so a desk with only a
// landline can leave this page open as its alert. "/" focuses search.
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
    document.addEventListener("keydown", function (e) {
      var a = document.activeElement;
      if (e.key === "/" && !(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) {
        var s = document.querySelector(".search input[name=q]");
        if (s) { e.preventDefault(); s.focus(); s.select(); }
      }
    });
    var busy = function () {
      var a = document.activeElement;
      if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return true;
      return Array.prototype.some.call(document.querySelectorAll("[data-guard] textarea, [data-guard] input:not([type=checkbox])"), function (el) { return el.value.trim() !== ""; })
        || !!document.querySelector("details[open]") || !!document.querySelector(".ask.open");
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
