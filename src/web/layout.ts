import { html, raw } from "hono/html";

export const stars = (n: number | null) =>
  n ? html`<span class="stars" aria-label="${n} of 5 stars">${"★".repeat(n)}<i>${"★".repeat(5 - n)}</i></span>` : "No rating";
export const statBox = (label: string, value: string) => html`<div class="stat"><span>${value}</span>${label}</div>`;

export function timeAgo(d: Date | string | null, now = new Date()): string {
  if (!d) return "";
  const min = Math.round((now.getTime() - new Date(d).getTime()) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} days ago`;
}

const ICON = {
  issues: `<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>`,
  replies: `<path d="M12 2.5l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.3l-5.8 3.1 1.1-6.5-4.7-4.6 6.5-.9z"/>`,
  metrics: `<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>`,
  upload: `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>`,
  qr: `<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM21 14v.01M14 21h.01M17 21h4v-4"/>`,
  pulse: `<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>`,
  bell: `<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>`,
  out: `<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>`,
};
export const icon = (name: keyof typeof ICON) =>
  raw(`<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`);

/** The loop mark, drawn in currentColor. */
export const mark = raw(
  `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M16.9 8.1A8 8 0 1 0 24 15.4" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="23.2" cy="8.8" r="1.7" fill="currentColor"/></svg>`,
);

const NAV = [
  { href: "/issues", label: "Guest issues", icon: "issues", count: "unacked", role: "Front desk" },
  { href: "/", label: "Review replies", icon: "replies", count: "awaiting", role: "General manager" },
  { href: "/metrics", label: "Pilot metrics", icon: "metrics", count: "", role: "Pilot" },
  { href: "/upload", label: "Upload report", icon: "upload", count: "", role: "ASI reports" },
  { href: "/setup", label: "Check-in QR", icon: "qr", count: "", role: "Front desk signage" },
  { href: "/operations", label: "Operations", icon: "pulse", count: "problems", role: "General manager" },
] as const;

export const isDemo = () => process.env.REVIEWLOOP_DEMO === "1";

export interface LayoutOpts {
  head?: unknown;
  /** false: guest-facing page with no staff chrome. */
  nav?: boolean;
  /** href of the nav item this page belongs to. */
  active?: string;
  lede?: unknown;
  /** Work surface: full width, compact header (Guest issues). */
  wide?: boolean;
  /** One-line confirmation after an action, shown as a toast. */
  flash?: Flash;
  /** A toast with an Undo button that posts to `action`. */
  undo?: { text: string; action: string };
}

export interface Flash {
  text: string;
  tone?: "ok" | "err";
}

export function layout(title: string, body: unknown, opts: LayoutOpts = {}) {
  const staff = opts.nav !== false;
  const idx = NAV.findIndex((n) => n.href === opts.active);
  const section = idx >= 0 ? NAV[idx] : undefined;
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>${title} · Reviewloop</title>
        ${head()}
        ${opts.head ?? ""}
      </head>
      <body class="${staff ? "staff" : "guest"}">
        ${staff
          ? html`<div class="shell">
              <aside class="side">
                <div class="drag"></div>
                <a class="brand" href="/issues">${mark}<span>reviewloop</span></a>
                <nav aria-label="Main">
                  ${NAV.map(
                    (n) => html`<a href="${n.href}" class="${n.href === opts.active ? "on" : ""}"
                      >${icon(n.icon)}<span>${n.label}</span>${n.count ? html`<b class="count" data-count="${n.count}" hidden></b>` : ""}</a
                    >`,
                  )}
                </nav>
                <div class="side-foot">
                  ${isDemo() ? html`<p class="demo-pill" title="Sample hotels and guests. Changes reset now and then.">Demo data</p>` : ""}
                  <button type="button" class="ghost" id="rl-alerts" hidden>${icon("bell")}<span>Turn on desktop alerts</span></button>
                  <form method="post" action="/logout"><button type="submit" class="ghost">${icon("out")}<span>Sign out</span></button></form>
                </div>
              </aside>
              <main class="${opts.wide ? "wide" : ""}">
                <header class="page-head ${opts.wide ? "compact" : ""}">
                  ${section
                    ? html`<div class="eyebrow"><span>[${String(idx + 1).padStart(2, "0")}]</span>${section.label}<i></i><span>/ ${section.role}</span></div>`
                    : ""}
                  <h1>${title}</h1>
                  ${opts.lede ? html`<p class="lede">${opts.lede}</p>` : ""}
                </header>
                ${body}
              </main>
            </div>
            <button type="button" class="fresh" id="rl-fresh" hidden onclick="location.reload()">New guest activity · Refresh</button>
            ${opts.flash ? html`<p class="toast ${opts.flash.tone ?? "ok"}" role="status">${opts.flash.text}</p>` : ""}
            ${opts.undo
              ? html`<form method="post" action="${opts.undo.action}" class="toast undo" role="status">
                  ${opts.undo.text}<button type="submit">Undo</button>
                </form>`
              : ""}
            <script>
              ${raw(STAFF_JS)}
            </script>`
          : html`<main class="guest-main">
              <h1>${title}</h1>
              ${body}
              <p class="powered">${mark} Texts by Reviewloop</p>
            </main>`}
      </body>
    </html>`;
}

/** Shared <head>: fonts, tokens and PWA wiring. Also used by the login and landing pages. */
export function head(extraCss = "") {
  return html`<meta name="theme-color" content="#29251E" media="(prefers-color-scheme: dark)" />
    <meta name="theme-color" content="#FBFAF7" media="(prefers-color-scheme: light)" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="icon" type="image/png" href="/favicon.png" />
    <link rel="apple-touch-icon" href="/icons/icon-180.png" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      rel="stylesheet"
      href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500&family=Inter:wght@400;500;600&display=swap"
    />
    <style>
      ${raw(CSS + extraCss)}
    </style>`;
}

// Badge, notifications and counts for the staff pages. Works in a browser tab, an installed
// web app (navigator.setAppBadge) and the desktop app (window.reviewloopDesktop).
const STAFF_JS = `
(function () {
  var desktop = window.reviewloopDesktop;
  // A confirmation shows once; reloading shouldn't repeat it.
  if (/[?&]ok=/.test(location.search) && history.replaceState) {
    var u = new URL(location.href); u.searchParams.delete("ok"); u.searchParams.delete("undo"); history.replaceState(null, "", u.pathname + u.search);
  }
  if (desktop) document.documentElement.classList.add("desktop", "desktop-" + desktop.platform);
  function apply(s) {
    document.querySelectorAll("[data-count]").forEach(function (el) {
      var v = s[el.getAttribute("data-count")] || 0;
      el.textContent = v > 99 ? "99+" : String(v);
      el.hidden = !v;
    });
    var n = s.unacked || 0;
    try {
      if (desktop) desktop.setBadge(n);
      else if (navigator.setAppBadge) n ? navigator.setAppBadge(n) : navigator.clearAppBadge();
    } catch (e) {}
    var key = "rl_notified", prev = 0;
    try { prev = Number(sessionStorage.getItem(key) || 0); sessionStorage.setItem(key, String(n)); } catch (e) {}
    if (n > prev && document.hidden && "Notification" in window && Notification.permission === "granted") {
      var note = new Notification(s.latestUrgent ? "Urgent guest issue" : "New guest issue", { body: s.latest || "", tag: "rl-issue" });
      note.onclick = function () { window.focus(); location.href = "/issues"; };
    }
  }
  function poll() {
    fetch("/api/status", { headers: { accept: "application/json" }, credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) { if (s) apply(s); })
      .catch(function () {});
  }
  poll();
  setInterval(poll, 30000);
  var btn = document.getElementById("rl-alerts");
  if (btn && !desktop && "Notification" in window && Notification.permission === "default") {
    btn.hidden = false;
    btn.onclick = function () { Notification.requestPermission().then(function () { btn.hidden = true; }); };
  }
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("/sw.js").catch(function () {});
})();
`;

const CSS = `
:root {
  --paper:#FBFAF7; --surface:#FFFFFF; --sunk:#F3F1EC; --ink:#29251E; --ink-2:#4A463F; --muted:#706D67; --faint:#9A968F;
  --line:#E8E4DC; --line-2:#D9D4CA; --hover:rgba(41,37,30,.045); --press:rgba(41,37,30,.08);
  --warn:#A8402B; --warn-bg:#FBEEE9; --warn-line:#EBC2B5; --ok:#3B6B45; --ok-bg:#EDF4EC; --gold:#B7832F;
  --shadow:0 1px 0 rgba(41,37,30,.04), 0 1px 2px rgba(41,37,30,.06);
  --shadow-2:0 1px 0 rgba(41,37,30,.04), 0 8px 24px -8px rgba(41,37,30,.14);
  --display:"Instrument Sans", "Inter", ui-sans-serif, system-ui, sans-serif;
  --ui:"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --r:12px; --r-sm:8px; --ease:cubic-bezier(.2,.7,.2,1);
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper:#171512; --surface:#1F1C18; --sunk:#14120F; --ink:#F3EFE8; --ink-2:rgba(243,239,232,.8); --muted:rgba(243,239,232,.64); --faint:rgba(243,239,232,.44);
    --line:rgba(243,239,232,.09); --line-2:rgba(243,239,232,.16); --hover:rgba(243,239,232,.05); --press:rgba(243,239,232,.09);
    --warn:#E88A73; --warn-bg:rgba(232,138,115,.1); --warn-line:rgba(232,138,115,.35); --ok:#8CC496; --ok-bg:rgba(140,196,150,.1); --gold:#D9A85A;
    --shadow:0 0 0 1px rgba(0,0,0,.2); --shadow-2:0 12px 32px -12px rgba(0,0,0,.6);
    color-scheme: dark;
  }
}
* { box-sizing:border-box; }
[hidden] { display:none !important; }
html { -webkit-text-size-adjust:100%; }
body { margin:0; background:var(--paper); color:var(--ink); font:14.5px/1.55 var(--ui); font-feature-settings:"cv11","ss01"; -webkit-font-smoothing:antialiased; }
a { color:inherit; }
h1, h2, h3 { font-weight:400; }
::selection { background:#29251E; color:#FBFAF7; }
:focus-visible { outline:2px solid var(--ink); outline-offset:2px; border-radius:6px; }
.i { width:16px; height:16px; flex:none; }
.mark { width:22px; height:22px; flex:none; }

/* ---------- Shell */
.shell { display:grid; grid-template-columns:232px minmax(0,1fr); min-height:100vh; }
.side { position:sticky; top:0; height:100vh; display:flex; flex-direction:column; gap:4px; padding:16px 12px; background:var(--sunk); border-right:1px solid var(--line); }
.drag { display:none; }
.brand { display:flex; align-items:center; gap:9px; padding:6px 10px 18px; text-decoration:none; font:500 19px/1 var(--display); letter-spacing:-.03em; }
.side nav { display:flex; flex-direction:column; gap:2px; }
.side nav a, .ghost { display:flex; align-items:center; gap:10px; width:100%; padding:7px 10px; border-radius:var(--r-sm); color:var(--muted); text-decoration:none; font:500 13.5px/1.2 var(--ui); background:none; border:0; cursor:pointer; transition:background .16s var(--ease), color .16s var(--ease); }
.side nav a:hover, .ghost:hover { background:var(--hover); color:var(--ink); }
.side nav a.on { background:var(--surface); color:var(--ink); box-shadow:var(--shadow); }
.side nav a span { flex:1; }
.count { min-width:20px; padding:1px 6px; border-radius:999px; background:var(--ink); color:var(--paper); font:600 11px/16px var(--ui); text-align:center; font-variant-numeric:tabular-nums; }
.count[data-count="awaiting"] { background:var(--line-2); color:var(--ink); }
.count[data-count="problems"] { background:var(--warn); color:#fff; }
.side-foot { margin-top:auto; display:flex; flex-direction:column; gap:2px; }
.side-foot form { margin:0; }
main { min-width:0; padding:40px clamp(16px, 4vw, 56px) 80px; max-width:1040px; }
.desktop-darwin .side { padding-top:44px; }
.desktop-darwin .drag { display:block; position:fixed; inset:0 0 auto 0; height:36px; -webkit-app-region:drag; z-index:5; pointer-events:none; }
.desktop-darwin main { padding-top:48px; }

/* ---------- Page header: numbered editorial label on a hairline, then a regular-weight headline */
.page-head { margin-bottom:28px; }
.eyebrow { display:flex; align-items:center; gap:10px; font:500 11px/1 var(--ui); letter-spacing:.09em; text-transform:uppercase; color:var(--muted); margin-bottom:18px; }
.eyebrow i { flex:1; height:1px; background:var(--line-2); }
.eyebrow span:first-child { color:var(--ink); font-variant-numeric:tabular-nums; }
h1 { font:400 clamp(30px, 4vw, 42px)/1.05 var(--display); letter-spacing:-.035em; margin:0; text-wrap:balance; }
.lede { color:var(--muted); max-width:60ch; margin:12px 0 0; font-size:15px; }
h2 { display:flex; align-items:center; gap:12px; margin:40px 0 14px; font:500 11px/1 var(--ui); letter-spacing:.09em; text-transform:uppercase; color:var(--muted); }
h2::after { content:""; flex:1; height:1px; background:var(--line); }

/* ---------- Stats */
.stats { display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:1px; margin:0 0 28px; background:var(--line); border:1px solid var(--line); border-radius:var(--r); overflow:hidden; }
.stat { background:var(--surface); padding:16px 18px 14px; color:var(--muted); font-size:12.5px; line-height:1.35; }
.stat span { display:block; margin-bottom:6px; font:400 32px/1 var(--display); letter-spacing:-.03em; color:var(--ink); font-variant-numeric:tabular-nums; }

/* ---------- Cards */
.card { position:relative; background:var(--surface); border:1px solid var(--line); border-radius:var(--r); padding:18px 20px; margin-bottom:12px; box-shadow:var(--shadow); transition:box-shadow .2s var(--ease), border-color .2s var(--ease); }
.card:hover { box-shadow:var(--shadow-2); }
.card.failed { border-color:var(--warn-line); }
.card.urgent { border-color:var(--warn-line); background:linear-gradient(var(--warn-bg), var(--warn-bg)), var(--surface); }
.card.urgent::before { content:""; position:absolute; left:-1px; top:14px; bottom:14px; width:3px; border-radius:0 3px 3px 0; background:var(--warn); }
.card header { display:flex; flex-wrap:wrap; align-items:center; gap:4px 8px; font-size:13px; color:var(--muted); }
.card header strong { color:var(--ink); font-weight:600; }
.card > p { margin:10px 0; }
.issue-title { font:400 20px/1.3 var(--display); letter-spacing:-.02em; margin:10px 0 4px; }
blockquote { margin:12px 0; padding:2px 0 2px 14px; border-left:2px solid var(--line-2); color:var(--ink-2); }
.stars { color:var(--gold); letter-spacing:1px; } .stars i { font-style:normal; color:var(--line-2); }

/* ---------- Forms */
textarea, input, select { width:100%; font:inherit; color:var(--ink); padding:9px 12px; border:1px solid var(--line-2); border-radius:var(--r-sm); background:var(--paper); transition:border-color .16s var(--ease), box-shadow .16s var(--ease); }
textarea { line-height:1.55; resize:vertical; }
textarea:focus, input:focus, select:focus { outline:none; border-color:var(--ink); box-shadow:0 0 0 3px var(--press); }
input[type=checkbox] { width:16px; height:16px; margin:2px 10px 0 0; accent-color:var(--ink); flex:none; }
input[type=file] { padding:7px; }
label { display:block; margin-bottom:14px; font-size:13px; font-weight:500; color:var(--ink-2); }
label:has(> input[type=checkbox]) { display:flex; align-items:flex-start; font-weight:400; color:var(--muted); }
label > input, label > select, label > textarea { margin-top:6px; }
.actions, .inline { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; } .inline input { flex:1; min-width:200px; }
.actions form { margin:0; }
button, .btn { display:inline-flex; align-items:center; justify-content:center; gap:8px; font:500 13.5px/1 var(--ui); padding:10px 16px; border-radius:var(--r-sm); border:1px solid var(--ink); background:var(--ink); color:var(--paper); cursor:pointer; white-space:nowrap; text-decoration:none; transition:transform .16s var(--ease), background .16s var(--ease), box-shadow .16s var(--ease); }
button:hover, .btn:hover { box-shadow:0 4px 14px -6px rgba(41,37,30,.5); }
button:active, .btn:active { transform:translateY(1px); }
button.secondary, .btn.secondary { background:var(--surface); color:var(--ink); border-color:var(--line-2); }
button.secondary:hover, .btn.secondary:hover { background:var(--hover); box-shadow:none; }
.side .ghost { box-shadow:none; transform:none; }

/* ---------- Tags */
.tag { display:inline-flex; align-items:center; gap:5px; font:500 11.5px/1 var(--ui); padding:4px 8px; border-radius:999px; background:var(--sunk); border:1px solid var(--line); color:var(--ink-2); white-space:nowrap; }
.tag.err { color:var(--warn); background:var(--warn-bg); border-color:var(--warn-line); }
.tag.err::before, .tag.good::before { content:""; width:6px; height:6px; border-radius:50%; background:currentColor; }
.tag.good { color:var(--ok); background:var(--ok-bg); border-color:transparent; }
.err { color:var(--warn); } .good { color:var(--ok); }
.empty { padding:40px 20px; text-align:center; color:var(--muted); border:1px dashed var(--line-2); border-radius:var(--r); background:var(--surface); }
.muted { color:var(--muted); } .small { font-size:12.5px; }
.spacer { flex:1; }
.form-card { max-width:560px; padding:22px 24px; }
button.wide { width:100%; padding:13px 16px; }

/* ---------- Threads */
.thread { margin:14px 0; display:flex; flex-direction:column; gap:6px; }
.msg { max-width:78%; padding:8px 12px; border-radius:14px; font-size:14px; line-height:1.45; }
.msg.in { align-self:flex-start; background:var(--sunk); border-bottom-left-radius:4px; }
.msg.out { align-self:flex-end; background:var(--ink); color:var(--paper); border-bottom-right-radius:4px; }
.msg small { display:block; margin-top:3px; font-size:11px; opacity:.62; }

/* ---------- Tables */
.table-wrap { overflow-x:auto; border:1px solid var(--line); border-radius:var(--r); background:var(--surface); }
table { width:100%; border-collapse:collapse; font-size:13px; font-variant-numeric:tabular-nums; }
td, th { text-align:left; padding:9px 12px; border-bottom:1px solid var(--line); white-space:nowrap; }
th { font-weight:500; color:var(--muted); font-size:12px; background:var(--sunk); }
tr:last-child td { border-bottom:0; }
.card table, main > table { border:1px solid var(--line); border-radius:var(--r); overflow:hidden; background:var(--surface); }

/* ---------- Guest pages */
.guest-main { max-width:460px; margin:0 auto; padding:48px 20px 40px; }
.guest-main h1 { margin-bottom:12px; }
.narrow { max-width:440px; margin:0 auto; }
.powered { display:flex; align-items:center; justify-content:center; gap:6px; margin-top:32px; color:var(--faint); font-size:12px; }
.powered .mark { width:16px; height:16px; }
.qr { background:#fff; padding:16px; display:inline-block; border-radius:var(--r); border:1px solid var(--line); }
.sign { text-align:center; padding:32px 20px; }
.sign h3 { font:400 28px/1.1 var(--display); letter-spacing:-.03em; margin:0 0 8px; }

/* ---------- Metrics charts */
.charts { display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:12px; margin:0 0 12px; }
.chart { margin:0; padding:14px 16px 10px; border:1px solid var(--line); border-radius:var(--r); background:var(--surface); }
.chart figcaption { display:grid; grid-template-columns:1fr auto; align-items:baseline; gap:2px 8px; margin-bottom:8px; }
.chart figcaption span { font-size:12.5px; color:var(--muted); }
.chart figcaption b { grid-row:span 2; font:400 24px/1 var(--display); letter-spacing:-.03em; font-variant-numeric:tabular-nums; }
.chart figcaption small { font-size:11px; color:var(--faint); }
.chart svg { display:block; width:100%; height:auto; overflow:visible; }
.chart .bar { fill:var(--ink); opacity:.82; transition:opacity .12s var(--ease); }
.chart g.on .bar { opacity:1; }
.chart .zero { fill:var(--line-2); }
.chart-empty { display:grid; place-items:center; aspect-ratio:320/120; margin:0; border-bottom:1px solid var(--line-2); color:var(--faint); font-size:12.5px; }
.chart .hit { fill:transparent; }
.chart .axis { stroke:var(--line-2); stroke-width:1; }
.chart .tick { font:11px var(--ui); fill:var(--faint); font-variant-numeric:tabular-nums; }
.chart-tip { position:fixed; z-index:30; transform:translate(-50%, -100%); padding:5px 9px; border-radius:6px; background:var(--ink); color:var(--paper); font-size:12px; pointer-events:none; white-space:nowrap; }
.table-details { margin-bottom:8px; }
.table-details summary { cursor:pointer; color:var(--muted); font-size:13px; padding:6px 0 10px; }
.table-details summary:hover { color:var(--ink); }

/* ---------- Operations */
.all-clear { display:flex; align-items:center; gap:10px; padding:14px 16px; margin:0 0 8px; border:1px solid var(--line); border-radius:var(--r); background:var(--surface); color:var(--ink-2); }
.ok-line { margin:0; padding:12px 14px; border:1px dashed var(--line-2); border-radius:var(--r); color:var(--muted); font-size:13.5px; }
td.clip { max-width:340px; overflow:hidden; text-overflow:ellipsis; }
td a { color:var(--ink); font-weight:500; text-underline-offset:2px; }
.fresh-list { display:grid; gap:1px; max-width:560px; margin:0 0 16px; border:1px solid var(--line); border-radius:var(--r); overflow:hidden; background:var(--line); }
.fresh-row { display:flex; flex-wrap:wrap; align-items:center; gap:8px 16px; padding:10px 14px; background:var(--surface); font-size:13.5px; }
.fresh-row strong { flex:1; min-width:120px; font-weight:600; }
.fresh-item { display:inline-flex; align-items:center; gap:6px; color:var(--muted); }
.fresh-note { display:flex; flex-wrap:wrap; align-items:center; gap:6px 10px; }

/* ---------- Upload */
.kinds { border:0; padding:0; margin:0 0 16px; display:grid; gap:8px; }
.kinds legend { font-size:13px; font-weight:500; color:var(--ink-2); margin-bottom:6px; padding:0; }
label.kind { display:flex; align-items:flex-start; gap:10px; margin:0; padding:10px 12px; border:1px solid var(--line-2); border-radius:var(--r-sm); cursor:pointer; font-weight:400; transition:border-color .16s var(--ease), background .16s var(--ease); }
label.kind:has(input:checked) { border-color:var(--ink); background:var(--sunk); }
label.kind input { width:16px; height:16px; margin:2px 0 0; accent-color:var(--ink); flex:none; }
label.kind span { display:flex; flex-direction:column; } label.kind strong { color:var(--ink); font-weight:500; } label.kind small { color:var(--muted); font-size:12.5px; }
.drop { position:relative; display:flex; flex-direction:column; align-items:center; gap:6px; margin:0 0 16px; padding:22px 16px; border:1.5px dashed var(--line-2); border-radius:var(--r); text-align:center; cursor:pointer; transition:border-color .16s var(--ease), background .16s var(--ease); }
.drop:hover, .drop:focus-within { border-color:var(--ink); background:var(--sunk); }
.drop input { position:absolute; inset:0; opacity:0; cursor:pointer; margin:0; }
.drop-cta { display:inline-flex; align-items:center; gap:8px; font-weight:500; color:var(--ink); }
.drop[data-file]:not([data-file=""]) { border-style:solid; border-color:var(--ink); }
.drop[data-file]:not([data-file=""]) .drop-name { display:none; }
.drop[data-file]:not([data-file=""])::after { content:attr(data-file); font-size:13px; color:var(--ink); }

/* ---------- Guest done + QR signs */
.done { padding:8px 0; } .done-title { margin:0 0 8px; font:400 30px/1.1 var(--display); letter-spacing:-.03em; }
.sign { position:relative; }
.sign-print { position:absolute; top:14px; right:14px; padding:7px 12px; font-size:12.5px; }

/* ---------- Work surface (Guest issues): compact header, full width, two panes */
main.wide { max-width:none; padding-top:28px; padding-bottom:24px; display:flex; flex-direction:column; height:100vh; }
.page-head.compact { display:flex; align-items:baseline; gap:16px; margin-bottom:16px; }
.page-head.compact .eyebrow { display:none; }
.page-head.compact h1 { font-size:28px; }
.workbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:16px; }
.chip { display:inline-flex; align-items:baseline; gap:6px; padding:6px 11px; border-radius:999px; background:var(--surface); border:1px solid var(--line); color:var(--muted); font-size:13px; }
.chip b { font:400 17px/1 var(--display); color:var(--ink); font-variant-numeric:tabular-nums; }
.chip.hot { border-color:var(--warn-line); background:var(--warn-bg); color:var(--warn); } .chip.hot b { color:var(--warn); }
.log { position:relative; }
.log summary { list-style:none; } .log summary::-webkit-details-marker { display:none; }
.pop { position:absolute; right:0; top:calc(100% + 8px); z-index:6; width:min(380px, calc(100vw - 32px)); padding:18px; background:var(--surface); border:1px solid var(--line); border-radius:var(--r); box-shadow:var(--shadow-2); }
.pop-title { margin:0 0 14px; font:400 18px/1.2 var(--display); letter-spacing:-.02em; }
.notice { margin:0 0 12px; padding:14px 16px; border:1px solid var(--line); border-radius:var(--r); background:var(--surface); }
.notice.warn { border-color:var(--warn-line); background:var(--warn-bg); display:flex; flex-wrap:wrap; gap:4px 10px; }
.notice-head { display:flex; flex-wrap:wrap; align-items:center; gap:4px 10px; margin-bottom:8px; }
.notice-row { display:grid; grid-template-columns:minmax(0,1.2fr) minmax(0,1fr) auto auto; align-items:center; gap:12px; padding:10px 0 0; margin-top:10px; border-top:1px solid var(--line); font-size:13.5px; }
.check { display:flex; align-items:center; margin:0; font-weight:400; color:var(--ink-2); white-space:nowrap; }
.inbox { display:grid; grid-template-columns:minmax(280px, 360px) minmax(0,1fr); flex:1; min-height:440px; border:1px solid var(--line); border-radius:var(--r); background:var(--surface); overflow:hidden; box-shadow:var(--shadow); }
.queue { overflow-y:auto; border-right:1px solid var(--line); background:var(--paper); }
.q-label { position:sticky; top:0; z-index:1; margin:0; padding:12px 16px 8px; font:500 11px/1 var(--ui); letter-spacing:.09em; text-transform:uppercase; color:var(--muted); background:var(--paper); }
.q-empty { padding:16px; color:var(--muted); margin:0; }
.q-row { display:grid; gap:2px; padding:12px 16px; border-bottom:1px solid var(--line); text-decoration:none; color:inherit; transition:background .16s var(--ease); }
a.q-row:hover { background:var(--hover); }
.q-row.on { background:var(--surface); box-shadow:inset 3px 0 0 var(--ink); }
.q-row.hot.on { box-shadow:inset 3px 0 0 var(--warn); }
.q-top { display:flex; justify-content:space-between; gap:8px; }
.q-top strong { font-weight:600; } .q-top time { color:var(--faint); font-size:12px; white-space:nowrap; font-variant-numeric:tabular-nums; }
.q-meta { color:var(--muted); font-size:12px; }
.q-sum { color:var(--ink-2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.q-tags { display:flex; flex-wrap:wrap; gap:4px; margin-top:6px; } .q-tags .tag { font-size:11px; padding:3px 7px; }
.q-row.quiet .q-sum { color:var(--muted); }
.pane { display:flex; flex-direction:column; min-width:0; min-height:0; }
.pane-head { display:flex; align-items:center; gap:12px; flex-wrap:wrap; padding:14px 20px; border-bottom:1px solid var(--line); }
.pane-head > div:first-of-type { display:flex; flex-direction:column; flex:1; min-width:160px; }
.pane-head strong { font-weight:600; font-size:15px; }
.pane-head .muted { font-size:12.5px; }
.pane-tags { display:flex; flex-wrap:wrap; gap:6px; }
.back { display:none; font-size:13px; color:var(--muted); text-decoration:none; }
.pane-body { flex:1; overflow-y:auto; padding:20px 24px; }
.pane-title { margin:0 0 4px; font:400 24px/1.25 var(--display); letter-spacing:-.025em; text-wrap:balance; }
.pane-body .thread { margin-top:20px; }
.msg.failed { box-shadow:0 0 0 1.5px var(--warn); } .msg.failed b { color:var(--warn); font-weight:600; }
.msg.out.failed b { color:#F2B5A5; }
.composer { padding:12px 16px 14px; border-top:1px solid var(--line); background:var(--surface); }
.compose { display:flex; gap:8px; align-items:flex-end; }
.compose textarea { flex:1; resize:none; min-height:42px; max-height:140px; }
.pane-actions { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-top:10px; }
.pane-actions form { margin:0; }
.resolve { display:flex; gap:8px; flex:1; } .resolve input { flex:1; }
.pane-empty { display:grid; place-items:center; text-align:center; padding:40px; } .pane-empty > div { max-width:340px; }
.fresh { position:fixed; left:50%; bottom:20px; transform:translateX(-50%); z-index:20; border-radius:999px; box-shadow:var(--shadow-2); }
.toast { position:fixed; left:50%; bottom:20px; transform:translateX(-50%); z-index:21; margin:0; padding:10px 16px; border-radius:999px; background:var(--ink); color:var(--paper); font-size:13.5px; box-shadow:var(--shadow-2); animation:toast 4.5s var(--ease) forwards; pointer-events:none; max-width:calc(100vw - 32px); }
.toast.err { background:var(--warn); color:#fff; }
.toast.undo { display:flex; align-items:center; gap:14px; padding:6px 6px 6px 16px; pointer-events:auto; animation-duration:9s; }
.toast.undo button { padding:7px 12px; border-radius:999px; background:var(--paper); color:var(--ink); border-color:var(--paper); font-size:13px; }
@media (prefers-color-scheme: dark) { .msg.in { background:rgba(243,239,232,.09); } }
@keyframes toast { 0% { opacity:0; transform:translate(-50%, 8px); } 6%, 85% { opacity:1; transform:translate(-50%, 0); } 100% { opacity:0; transform:translate(-50%, 4px); visibility:hidden; } }
.demo-pill { margin:0 10px 8px; padding:4px 9px; align-self:flex-start; border:1px dashed var(--line-2); border-radius:999px; color:var(--muted); font-size:11.5px; }
.side-signout { display:none; }

@media (max-width: 1000px) {
  main.wide { height:auto; display:block; }
  .inbox { display:block; height:auto; min-height:0; border:0; background:none; box-shadow:none; overflow:visible; }
  .queue { border:1px solid var(--line); border-radius:var(--r); overflow:hidden; background:var(--surface); }
  .q-label { position:static; }
  .inbox .pane { display:none; }
  .inbox.has-sel .queue { display:none; }
  .inbox.has-sel .pane { display:flex; border:1px solid var(--line); border-radius:var(--r); background:var(--surface); }
  .back { display:inline-block; width:100%; }
  .pane-body { overflow:visible; }
  .composer { position:sticky; bottom:0; border-radius:0 0 var(--r) var(--r); }
  .notice-row { grid-template-columns:1fr; gap:6px; }
}

@media (max-width: 760px) {
  .shell { display:block; }
  .side { position:sticky; z-index:4; height:auto; flex-direction:row; align-items:center; gap:4px; padding:8px 12px; border-right:0; border-bottom:1px solid var(--line); overflow-x:auto; scrollbar-width:none; }
  .side .brand { padding:6px 8px 6px 2px; }
  .side .brand span { display:none; }
  .side nav { flex-direction:row; }
  .side nav a { width:auto; white-space:nowrap; }
  .side-foot { display:flex; flex-direction:row; margin:0 0 0 auto; }
  .side-foot #rl-alerts, .side-foot .demo-pill { display:none !important; }
  .side-foot .ghost span { display:none; }
  main { padding:28px 16px 64px; }
  .msg { max-width:90%; }
}
@media (prefers-reduced-motion: reduce) { * { transition:none !important; animation:none !important; } }
@media print { body[data-print] .sign:not(.print-me) { display:none; } .sign { break-after:page; border:0; } .sign:last-child { break-after:auto; }
  .page-head { display:none !important; }
  .side, .noprint, .toast, .fresh { display:none !important; } .shell { display:block; } .card { box-shadow:none; break-inside:avoid; } }
`;
