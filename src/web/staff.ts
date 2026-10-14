import { html, raw } from "hono/html";
import { DateTime } from "luxon";
import type { Db } from "../db.js";
import { listDevices, listStaff, type StaffRow } from "../staff.js";
import type { Viewer } from "../viewer.js";
import { initials, ROLE_LABEL } from "./account.js";
import { head, isDemo, layout, mark, timeAgo, type Flash } from "./layout.js";
import { LOGIN_CSS } from "./login.js";

/** The GM's Staff page, the activity log, each person's account page, and the desk PC name picker. */

export interface StaffForm {
  name?: string;
  username?: string;
  role?: string;
  error?: string;
}

const tabs = (on: "/staff" | "/audit") =>
  html`<nav class="seg" aria-label="Staff sections">
    <a href="/staff" class="${on === "/staff" ? "on" : ""}" ${on === "/staff" ? raw('aria-current="page"') : ""}>People and desk PCs</a>
    <a href="/audit" class="${on === "/audit" ? "on" : ""}" ${on === "/audit" ? raw('aria-current="page"') : ""}>Activity log</a>
  </nav>`;

export async function staffPage(db: Db, now: Date, v: Viewer, opts: { flash?: Flash; form?: StaffForm; rowError?: { id: string; text: string }; thisDevice: string | null }) {
  const people = await listStaff(db);
  const devices = await listDevices(db);
  const here = devices.find((d) => d.id === opts.thisDevice);
  const f = opts.form ?? {};
  const role = f.role === "gm" ? "gm" : "desk";
  return layout(
    "Staff",
    html`
      ${tabs("/staff")}
      <h2>People · ${people.length}</h2>
      <ul class="people">
        ${people.map((p) => personRow(p, v, now, opts.rowError?.id === p.id ? opts.rowError.text : undefined))}
      </ul>

      <h2>Add a person</h2>
      <form method="post" action="/staff" class="card form-card add-staff" autocomplete="off">
        ${f.error ? html`<p class="err small" role="alert">${f.error}</p>` : ""}
        <label>Name <input name="name" required maxlength="40" value="${f.name ?? ""}" placeholder="Maria Lopez" /></label>
        <fieldset class="roles">
          <legend>Role</legend>
          <label class="kind"><input type="radio" name="role" value="desk" ${role === "desk" ? "checked" : ""} />
            <span><strong>Front desk</strong><small>Guest issues, uploading reports and the QR sign</small></span></label>
          <label class="kind"><input type="radio" name="role" value="gm" ${role === "gm" ? "checked" : ""} />
            <span><strong>GM</strong><small>Everything, plus approving review replies, Operations, Metrics and Staff</small></span></label>
        </fieldset>
        <div class="two">
          <label>4-digit PIN <span class="muted small">· switching in at a desk PC</span>
            <input name="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="off" placeholder="••••" /></label>
          <label>Password <span class="muted small">· signing in anywhere else</span>
            <input name="password" type="password" minlength="8" autocomplete="new-password" placeholder="At least 8 characters" /></label>
        </div>
        <details class="more">
          <summary>Username</summary>
          <label>Username <span class="muted small">· for signing in with a password. Leave blank to use their first name.</span>
            <input name="username" maxlength="32" value="${f.username ?? ""}" autocapitalize="none" spellcheck="false" /></label>
        </details>
        <p class="muted small">Front desk needs a PIN, a password, or both. A GM needs a password. Tell them their PIN and password in person; they can change them later under their name, top right.</p>
        <button type="submit" data-busy-text="Adding…">Add person</button>
      </form>

      <h2>Front desk PCs</h2>
      <p class="lede tight">On a shared front desk computer, staff pick their name and type their PIN instead of a password, and it goes back to the name screen after ${v.idleMinutes} minutes nobody touches it. PINs only work on computers listed here.</p>
      ${devices.length
        ? html`<ul class="devices">
            ${devices.map(
              (d) => html`<li>
                <span class="dev-ico" aria-hidden="true">${raw(PC_ICON)}</span>
                <span class="dev-main"><strong>${d.label}</strong>${d.id === opts.thisDevice ? html` <span class="tag good">This computer</span>` : ""}
                  <small class="muted">Set up by ${d.created_by} ${timeAgo(d.created_at, now)}${d.last_used ? html` · last used ${timeAgo(d.last_used, now)}` : ""}</small></span>
                <form method="post" action="/staff/devices/${d.id}/remove" onsubmit="return confirm('Stop using ${d.label.replace(/['"\\<>]/g, "")} as a front desk PC? Anyone signed in there is signed out.')">
                  <button type="submit" class="secondary small-btn">Remove</button>
                </form>
              </li>`,
            )}
          </ul>`
        : ""}
      ${here
        ? ""
        : html`<form method="post" action="/staff/devices" class="card form-card dev-add">
            <label>Make <em>this</em> computer a front desk PC <input name="label" maxlength="40" value="Front desk" required /></label>
            <button type="submit" class="secondary" data-busy-text="Setting up…">Use this computer for the front desk</button>
            <p class="muted small">Do this on the shared desk computer itself, not your own laptop or phone.</p>
          </form>`}
    `,
    { active: "/staff", flash: opts.flash, head: html`<style>${raw(STAFF_CSS)}</style>`, lede: "Everyone gets their own sign-in, so the activity log shows who took, texted and resolved each issue." },
  );
}

function personRow(p: StaffRow, v: Viewer, now: Date, error?: string) {
  const self = p.id === v.id;
  return html`<li class="person">
    <span class="av lg" aria-hidden="true">${initials(p.name)}</span>
    <span class="p-main">
      <strong>${p.name}${self ? html` <span class="muted">(you)</span>` : ""}</strong>
      <small class="muted">${p.username} · ${p.has_pin ? "PIN" : "No PIN"} · ${p.has_password ? "Password" : "No password"}</small>
    </span>
    <span class="tag ${p.role === "gm" ? "gm" : ""}">${ROLE_LABEL[p.role]}</span>
    <span class="p-seen muted small">${p.last_active_at ? `Active ${timeAgo(p.last_active_at, now)}` : "Never signed in"}</span>
    <details class="menu p-menu" ${error ? "open" : ""}>
      <summary class="btn secondary small-btn" aria-label="Manage ${p.name}">Manage</summary>
      <div class="pop">
        <p class="pop-title">${p.name}</p>
        ${error ? html`<p class="err small" role="alert">${error}</p>` : ""}
        <form method="post" action="/staff/${p.id}/reset" autocomplete="off">
          <div class="two">
            <label>New PIN <input name="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="off" placeholder="••••" /></label>
            <label>New password <input name="password" type="password" minlength="8" autocomplete="new-password" /></label>
          </div>
          <p class="muted small">Fill in either or both. They're signed out everywhere until they use the new one.</p>
          <button type="submit" data-busy-text="Saving…">Reset</button>
        </form>
        ${self
          ? html`<p class="muted small sep">You can't change your own role or remove yourself. Another GM can.</p>`
          : html`<div class="pop-actions sep">
              <form method="post" action="/staff/${p.id}/role">
                <input type="hidden" name="role" value="${p.role === "gm" ? "desk" : "gm"}" />
                <button type="submit" class="secondary">${p.role === "gm" ? "Make front desk" : "Make GM"}</button>
              </form>
              <form method="post" action="/staff/${p.id}/remove" onsubmit="return confirm('Remove ${p.name.replace(/['"\\<>]/g, "")}? They're signed out now and can't sign in again. Their name stays in the activity log.')">
                <button type="submit" class="secondary danger">Remove</button>
              </form>
            </div>`}
      </div>
    </details>
  </li>`;
}

// ---------- Activity log

export const AUDIT_FILTERS = {
  all: { label: "Everything", actions: null },
  issues: { label: "Guest issues", actions: ["case.take", "case.text", "case.resolve", "case.log", "consent.approve"] },
  replies: { label: "Review replies", actions: ["draft.approve", "draft.post_failed", "draft.dismiss", "draft.restore"] },
  signins: { label: "Sign-ins", actions: ["signin.password", "signin.pin", "signout.idle"] },
  staff: { label: "Staff changes", actions: ["staff.add", "staff.remove", "staff.reset", "staff.role", "device.add", "device.remove"] },
} as const;
export type AuditFilter = keyof typeof AUDIT_FILTERS;

interface AuditRow {
  id: string;
  at: Date;
  actor: string;
  action: string;
  subject_id: string | null;
  detail: string | null;
  device: string | null;
  imported: boolean;
  case_summary: string | null;
  guest: string | null;
  room: string | null;
  author: string | null;
  rating: number | null;
  consent_room: string | null;
  staff_name: string | null;
}

const PAGE = 100;

export async function auditPage(db: Db, now: Date, opts: { filter?: string; who?: string; before?: string }) {
  const filter: AuditFilter = opts.filter && opts.filter in AUDIT_FILTERS ? (opts.filter as AuditFilter) : "all";
  const actions = AUDIT_FILTERS[filter].actions;
  const who = opts.who && /^\d+$/.test(opts.who) ? opts.who : null;
  const cursor = opts.before?.match(/^(\d{4}-[\d\-T:.]+Z)_(\d+)$/);
  const rows = await db.query<AuditRow>(
    `select a.id::text, a.at, a.actor, a.action, a.subject_id::text, a.detail, a.device, a.imported,
            c.summary as case_summary, nullif(concat_ws(' ', s.guest_first_name, s.guest_last_name), '') as guest, s.room,
            r.author, r.rating, co.room as consent_room, st.name as staff_name
       from audit_log a
       left join recovery_cases c on a.action like 'case.%' and c.id = a.subject_id
       left join stays s on s.id = c.stay_id
       left join reply_drafts d on a.action like 'draft.%' and d.id = a.subject_id
       left join reviews r on r.id = d.review_id
       left join consents co on a.action = 'consent.approve' and co.id = a.subject_id
       left join staff st on a.action like 'staff.%' and st.id = a.subject_id
      where ($1::text[] is null or a.action = any($1::text[]))
        and ($2::bigint is null or a.staff_id = $2::bigint)
        and ($3::timestamptz is null or (a.at, a.id) < ($3::timestamptz, $4::bigint))
      order by a.at desc, a.id desc limit ${PAGE + 1}`,
    [actions ? [...actions] : null, who, cursor?.[1] ?? null, cursor?.[2] ?? null],
  );
  const more = rows.length > PAGE;
  const shown = rows.slice(0, PAGE);
  const people = await db.query<{ id: string; name: string; removed: boolean }>(
    "select id::text, name, removed_at is not null as removed from staff where exists (select 1 from audit_log a where a.staff_id = staff.id) order by removed_at is not null, lower(name)",
  );
  const [tzRow] = await db.query<{ timezone: string }>("select timezone from properties order by id limit 1");
  const tz = tzRow?.timezone ?? "America/Los_Angeles";
  const q = (over: Record<string, string | null>) => {
    const p = new URLSearchParams();
    const merged = { filter: filter === "all" ? null : filter, who, ...over };
    for (const [k, val] of Object.entries(merged)) if (val) p.set(k, val);
    const s = p.toString();
    return s ? `/audit?${s}` : "/audit";
  };
  // Group by local day so a shift reads top to bottom.
  let lastDay = "";
  const last = shown[shown.length - 1];
  return layout(
    "Activity log",
    html`
      ${tabs("/audit")}
      <div class="audit-tools">
        <div class="chips-row" role="group" aria-label="Show">
          ${(Object.keys(AUDIT_FILTERS) as AuditFilter[]).map(
            (k) => html`<a class="fchip ${k === filter ? "on" : ""}" href="${q({ filter: k === "all" ? null : k, before: null })}" ${k === filter ? raw('aria-current="true"') : ""}>${AUDIT_FILTERS[k].label}</a>`,
          )}
        </div>
        <form method="get" action="/audit" class="who-form">
          ${filter !== "all" ? html`<input type="hidden" name="filter" value="${filter}" />` : ""}
          <label class="sr" for="who">Person</label>
          <select name="who" id="who" onchange="this.form.submit()">
            <option value="">Everyone</option>
            ${people.map((p) => html`<option value="${p.id}" ${p.id === who ? "selected" : ""}>${p.name}${p.removed ? " (removed)" : ""}</option>`)}
          </select>
          <noscript><button type="submit" class="secondary">Show</button></noscript>
        </form>
      </div>
      ${shown.length === 0
        ? html`<p class="empty">Nothing here yet. Actions show up as soon as someone takes, texts or resolves an issue, or decides on a reply.</p>`
        : html`<ol class="audit">
            ${shown.map((r) => {
              const at = DateTime.fromJSDate(new Date(r.at), { zone: tz });
              const day = at.toFormat("cccc, LLL d");
              const header = day !== lastDay ? ((lastDay = day), html`<li class="audit-day">${at.hasSame(DateTime.fromJSDate(now, { zone: tz }), "day") ? "Today" : day}</li>`) : "";
              return html`${header}<li class="audit-row">
                <time datetime="${new Date(r.at).toISOString()}">${at.toFormat("h:mm a")}</time>
                <span class="av" aria-hidden="true">${initials(r.actor)}</span>
                <span class="a-text"><strong>${r.actor}</strong> ${describe(r)}
                  ${r.device ? html`<span class="tag">${r.device} PC</span>` : ""}
                  ${r.imported ? html`<span class="tag" title="Recorded before everyone had their own sign-in, so it may have been anyone using the shared login">Shared login</span>` : ""}</span>
              </li>`;
            })}
          </ol>
          ${more && last ? html`<div class="actions"><a class="btn secondary" href="${q({ before: `${new Date(last.at).toISOString()}_${last.id}` })}">Older</a></div>` : ""}`}
    `,
    {
      active: "/staff",
      head: html`<style>${raw(STAFF_CSS)}</style>`,
      lede: "Who took, texted, resolved, approved or dismissed what, and when. Times are the hotel’s local time.",
    },
  );
}

function describe(r: AuditRow) {
  const guest = [r.guest, r.room ? `room ${r.room}` : null].filter(Boolean).join(", ");
  const issue = r.subject_id
    ? html` · <a href="/issues?id=${r.subject_id}">${guest || "Guest"}${r.case_summary && r.case_summary !== "[redacted]" ? html`: ${clip(r.case_summary)}` : ""}</a>`
    : "";
  const review = html`${r.author ? `${r.author}’s ` : ""}${r.rating ? `${r.rating}★ ` : ""}review`;
  switch (r.action) {
    case "case.take": return html`took an issue${issue}`;
    case "case.text": return html`texted a guest${issue}`;
    case "case.resolve": return html`resolved an issue${issue}`;
    case "case.log": return html`logged an issue${issue}`;
    case "consent.approve": return html`confirmed a check-in text sign-up${r.consent_room && r.consent_room !== "[redacted]" ? ` for room ${r.consent_room}` : ""}`;
    case "draft.approve": return html`approved and posted a reply to ${review}`;
    case "draft.post_failed": return html`approved a reply to ${review}, but posting failed`;
    case "draft.dismiss": return html`dismissed the reply draft for ${review}`;
    case "draft.restore": return html`brought back the reply draft for ${review}`;
    case "signin.password": return html`signed in with a password`;
    case "signin.pin": return html`switched in with their PIN`;
    case "signout.idle": return html`was signed out after no activity`;
    case "staff.add": return html`added ${r.staff_name ?? "someone"}${r.detail ? ` as ${r.detail}` : ""}`;
    case "staff.remove": return html`removed ${r.staff_name ?? "someone"}`;
    case "staff.reset": return html`reset ${r.staff_name ?? "someone"}’s ${r.detail ?? "sign-in"}`;
    case "staff.role": return html`made ${r.staff_name ?? "someone"} ${r.detail ?? ""}`;
    case "device.add": return html`set up ${r.detail ?? "a computer"} as a front desk PC`;
    case "device.remove": return html`stopped using ${r.detail ?? "a computer"} as a front desk PC`;
    default: return r.action;
  }
}

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---------- Your account

export function accountPage(v: Viewer, opts: { has: { password: boolean; pin: boolean }; flash?: Flash; error?: { form: "password" | "pin"; text: string } }) {
  const err = (form: "password" | "pin") => (opts.error?.form === form ? html`<p class="err small" role="alert">${opts.error.text}</p>` : "");
  const current = html`<label>Current password${opts.has.pin ? " or PIN" : ""}
    <input name="current" type="password" required autocomplete="current-password" /></label>`;
  return layout(
    "Your account",
    html`
      <div class="acct-head">
        <span class="av xl" aria-hidden="true">${initials(v.name)}</span>
        <div><strong>${v.name}</strong><span class="muted">${ROLE_LABEL[v.role]}${v.device ? ` · on the ${v.device.label} PC` : ""}</span></div>
      </div>
      <div class="acct-grid">
        <form method="post" action="/account/pin" class="card form-card" autocomplete="off">
          <h3>${opts.has.pin ? "Change your PIN" : "Add a PIN"}</h3>
          <p class="muted small">For switching in at a front desk PC: pick your name, type your PIN.</p>
          ${err("pin")}
          ${current}
          <label>New 4-digit PIN <input name="pin" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required autocomplete="off" /></label>
          <button type="submit" data-busy-text="Saving…">Save PIN</button>
        </form>
        <form method="post" action="/account/password" class="card form-card">
          <h3>${opts.has.password ? "Change your password" : "Add a password"}</h3>
          <p class="muted small">For signing in on your own phone or laptop. You'll stay signed in here.</p>
          ${err("password")}
          ${current}
          <label>New password <input name="password" type="password" minlength="8" required autocomplete="new-password" /></label>
          <button type="submit" data-busy-text="Saving…">Save password</button>
        </form>
      </div>
      <p class="muted small">Forgot both? Ask a GM to reset them from the Staff page.</p>
    `,
    { active: "", flash: opts.flash, head: html`<style>${raw(STAFF_CSS)}</style>` },
  );
}

// ---------- "Who's at the desk?" on a shared front desk PC

export function switchPage(opts: { device: string; people: { id: string; name: string; role: string }[]; next: string; selected?: string; error?: string; idle?: boolean }) {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Who’s at the desk? · Reviewloop</title>
        ${head(LOGIN_CSS + SWITCH_CSS)}
      </head>
      <body class="login">
        <div class="sky" aria-hidden="true"></div>
        <main class="login-card switch-card">
          <a class="brand" href="/welcome">${mark}<span>reviewloop</span></a>
          <h1>Who’s at the desk?</h1>
          <p class="muted">${opts.device} PC · pick your name, then type your PIN.</p>
          ${opts.idle && !opts.error ? html`<p class="hint" role="status">Signed out after a while with no activity, so the next person isn’t working under your name.</p>` : ""}
          ${opts.error ? html`<p class="err" role="alert">${opts.error}</p>` : ""}
          ${isDemo() ? html`<p class="hint">Demo PINs: Maria <b>2468</b>, Tom <b>1357</b>, Raj (GM) <b>8080</b></p>` : ""}
          ${opts.people.length
            ? html`<form method="post" action="/switch" id="switch">
                <input type="hidden" name="next" value="${opts.next}" />
                <fieldset class="names">
                  <legend class="sr">Your name</legend>
                  ${opts.people.map(
                    (p, i) => html`<label class="name">
                      <input type="radio" name="staff" value="${p.id}" required ${opts.selected ? (opts.selected === p.id ? "checked" : "") : i === 0 && opts.people.length === 1 ? "checked" : ""} />
                      <span class="av" aria-hidden="true">${initials(p.name)}</span><span class="nm">${p.name}</span>
                    </label>`,
                  )}
                </fieldset>
                <label class="pin-label">PIN
                  <input class="pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required autocomplete="off" ${opts.selected ? "autofocus" : ""} /></label>
                <button type="submit" class="wide">Continue</button>
              </form>
              <script>
                ${raw(`(function () {
  var f = document.getElementById("switch"), pin = f.pin;
  f.addEventListener("change", function (e) { if (e.target.name === "staff") { pin.value = ""; pin.focus(); } });
  pin.addEventListener("input", function () {
    pin.value = pin.value.replace(/\\D/g, "").slice(0, 4);
    if (pin.value.length === 4 && f.querySelector("input[name=staff]:checked")) f.requestSubmit ? f.requestSubmit() : f.submit();
  });
})();`)}
              </script>`
            : html`<p class="hint">Nobody has a PIN yet. A GM can add PINs on the Staff page.</p>`}
          <p class="alt"><a href="/login?password=1&next=${encodeURIComponent(opts.next)}">Sign in with a password instead</a></p>
        </main>
      </body>
    </html>`;
}

const PC_ICON = `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/></svg>`;

const STAFF_CSS = `
.sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
.seg { display:inline-flex; gap:2px; padding:3px; margin:0 0 4px; border-radius:var(--r-sm); background:var(--sunk); border:1px solid var(--line); }
.seg a { padding:6px 12px; border-radius:6px; color:var(--muted); text-decoration:none; font-size:var(--fs-md); font-weight:500; white-space:nowrap; }
.seg a:hover { color:var(--ink); }
.seg a.on { background:var(--surface); color:var(--ink); box-shadow:var(--ring); }
.lede.tight { margin:-4px 0 14px; }
.people, .devices, .audit { list-style:none; margin:0; padding:0; border:1px solid var(--line); border-radius:var(--r); background:var(--surface); }
.person, .devices li { display:grid; grid-template-columns:auto minmax(0,1fr) auto auto auto; align-items:center; gap:12px; padding:12px 14px; border-bottom:1px solid var(--line); }
.devices li { grid-template-columns:auto minmax(0,1fr) auto; }
.person:last-child, .devices li:last-child { border-bottom:0; }
.p-main, .dev-main { display:grid; gap:2px; min-width:0; }
.p-main strong, .dev-main strong { font-weight:600; font-size:var(--fs-base); }
.p-main small, .dev-main small { font-size:var(--fs-sm); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.p-seen { min-width:120px; text-align:right; }
.av.lg { width:32px; height:32px; font-size:11.5px; }
.av.xl { width:48px; height:48px; font-size:16px; }
.person .tag { justify-self:end; }
.tag.gm { background:var(--ink); color:var(--paper); }
.small-btn { padding:7px 11px; font-size:var(--fs-md); }
.p-menu .pop { width:min(360px, calc(100vw - 32px)); }
.p-menu summary { list-style:none; } .p-menu summary::-webkit-details-marker { display:none; }
.pop form { margin:0; }
.pop .sep { margin-top:14px; padding-top:14px; border-top:1px solid var(--line); }
.pop-actions { display:flex; gap:8px; flex-wrap:wrap; }
button.danger { color:var(--warn); }
button.danger:hover { background:var(--warn-bg); border-color:var(--warn-line); }
.two { display:grid; grid-template-columns:1fr 1fr; gap:0 12px; }
.roles { border:0; padding:0; margin:0 0 14px; display:grid; gap:8px; }
.roles legend { font-size:var(--fs-md); font-weight:500; color:var(--ink-2); margin-bottom:6px; padding:0; }
.roles .kind { margin:0; }
.more { margin:0 0 12px; }
.more summary { cursor:pointer; color:var(--muted); font-size:var(--fs-md); padding:2px 0 10px; }
.more summary:hover { color:var(--ink); }
.add-staff > p.muted { margin:0 0 16px; }
.dev-ico { display:grid; place-items:center; width:32px; height:32px; border-radius:var(--r-sm); background:var(--sunk); color:var(--muted); }
.dev-add { margin-top:12px; }
.dev-add p { margin:10px 0 0; }
.audit-tools { display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin:20px 0 16px; }
.chips-row { display:flex; flex-wrap:wrap; gap:6px; flex:1; }
.fchip { padding:6px 11px; border-radius:var(--r-pill); border:1px solid var(--line); background:var(--surface); color:var(--muted); text-decoration:none; font-size:var(--fs-md); font-weight:500; white-space:nowrap; }
.fchip:hover { color:var(--ink); border-color:var(--line-2); }
.fchip.on { background:var(--ink); border-color:var(--ink); color:var(--paper); }
.who-form { margin:0; } .who-form select { width:auto; min-width:160px; padding:7px 10px; }
.audit { border:0; background:none; }
.audit-day { padding:18px 0 8px; font-size:var(--fs-sm); font-weight:500; color:var(--muted); border-bottom:1px solid var(--line); }
.audit-day:first-child { padding-top:0; }
.audit-row { display:grid; grid-template-columns:64px auto minmax(0,1fr); align-items:start; gap:10px; padding:10px 0; border-bottom:1px solid var(--line); font-size:var(--fs-base); }
.audit-row time { padding-top:3px; color:var(--muted); font-size:var(--fs-md); font-variant-numeric:tabular-nums; }
.a-text { padding-top:2px; line-height:1.5; }
.a-text strong { font-weight:600; }
.a-text a { color:var(--ink-2); text-underline-offset:2px; }
.a-text .tag { margin-left:4px; vertical-align:1px; }
.acct-head { display:flex; align-items:center; gap:14px; margin:0 0 20px; }
.acct-head div { display:grid; gap:2px; } .acct-head strong { font-size:var(--fs-d1); font-weight:600; }
.acct-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:12px; max-width:760px; }
.acct-grid .form-card { max-width:none; margin:0; }
.acct-grid h3 { margin:0 0 4px; font-size:var(--fs-lg); font-weight:600; }
.acct-grid p.muted { margin:0 0 16px; }
@media (max-width: 760px) {
  .person { grid-template-columns:auto minmax(0,1fr) auto; row-gap:6px; }
  .person .tag { grid-column:3; grid-row:1; }
  .p-seen { grid-column:2; grid-row:2; text-align:left; min-width:0; }
  .p-menu { grid-column:3; grid-row:2; justify-self:end; }
  .p-menu .pop { position:fixed; left:12px; right:12px; top:auto; bottom:72px; width:auto; }
  .two { grid-template-columns:1fr; }
  .audit-row { grid-template-columns:auto minmax(0,1fr); }
  .audit-row time { grid-column:2; grid-row:2; padding:0; font-size:var(--fs-sm); }
  .audit-row .av { grid-row:1 / span 2; }
  .who-form, .who-form select { width:100%; }
}
`;

const SWITCH_CSS = `
.switch-card { max-width:440px; }
.sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
.names { border:0; padding:0; margin:0 0 16px; display:grid; grid-template-columns:repeat(auto-fill, minmax(120px, 1fr)); gap:8px; }
.name { position:relative; display:flex; align-items:center; gap:10px; margin:0; padding:10px 12px; border-radius:var(--r-md); border:1px solid rgba(41,37,30,.1); background:rgba(255,255,255,.7); cursor:pointer; font-size:var(--fs-base); font-weight:500; color:var(--ink); transition:border-color .14s var(--ease), background .14s var(--ease); }
.name:hover { background:#fff; }
.name input { position:absolute; opacity:0; inset:0; margin:0; cursor:pointer; }
.name:has(input:checked) { border-color:var(--ink); background:#fff; box-shadow:0 0 0 1px var(--ink); }
.name:has(input:focus-visible) { outline:2px solid var(--accent); outline-offset:2px; }
.name .nm { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pin { font-size:24px !important; letter-spacing:.6em; text-align:center; padding:12px !important; }
.alt { margin:18px 0 0; text-align:center; font-size:var(--fs-md); }
.alt a { color:var(--muted); text-underline-offset:2px; }
.alt a:hover { color:var(--ink); }
`;
