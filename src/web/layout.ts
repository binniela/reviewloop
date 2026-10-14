import { html, raw } from "hono/html";
import { currentViewer, isGm } from "../viewer.js";
import { ACCOUNT_CSS, accountMenu, deskIdle } from "./account.js";

export const stars = (n: number | null) =>
  n ? html`<span class="stars" role="img" aria-label="${n} of 5 stars">${"★".repeat(n)}<i>${"☆".repeat(5 - n)}</i></span>` : "No rating";
export const statBox = (label: string, value: string) => html`<div class="stat"><span>${value}</span>${label}</div>`;

/** +16265550100 → (626) 555-0100; anything else as stored. */
export const phoneLabel = (p: string) => {
  const m = p.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : p;
};

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
  alert: `<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>`,
  bag: `<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>`,
  chat: `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`,
  x: `<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`,
  send: `<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>`,
  sort: `<path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/>`,
  search: `<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>`,
  spark: `<path d="M12 3v18"/><path d="m4.2 7.5 15.6 9"/><path d="m4.2 16.5 15.6-9"/>`,
  plus: `<path d="M12 5v14"/><path d="M5 12h14"/>`,
  pulse: `<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>`,
  bell: `<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>`,
  check: `<path d="M20 6 9 17l-5-5"/>`,
  hotel: `<path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"/><path d="M16 9h2a2 2 0 0 1 2 2v10"/><path d="M2 21h20"/><path d="M8 7h4M8 11h4M8 15h4"/>`,
  users: `<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`,
  out: `<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>`,
};
export const icon = (name: keyof typeof ICON) =>
  raw(`<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`);

/** The loop mark, drawn in currentColor. */
export const mark = raw(
  `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M16.9 8.1A8 8 0 1 0 24 15.4" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="23.2" cy="8.8" r="1.7" fill="currentColor"/></svg>`,
);

const NAV = [
  { href: "/issues", label: "Guest issues", short: "Issues", icon: "issues", count: "unacked" },
  { href: "/", label: "Review replies", short: "Replies", icon: "replies", count: "awaiting", gm: true },
  { href: "/metrics", label: "Pilot metrics", short: "Metrics", icon: "metrics", count: "", gm: true },
  { href: "/upload", label: "Upload report", short: "Upload", icon: "upload", count: "" },
  { href: "/setup", label: "Check-in QR", short: "QR sign", icon: "qr", count: "" },
  { href: "/hotels", label: "Hotel setup", short: "Hotels", icon: "hotel", count: "", gm: true },
  { href: "/operations", label: "Operations", short: "Operations", icon: "pulse", count: "problems", gm: true },
  { href: "/staff", label: "Staff", short: "Staff", icon: "users", count: "", gm: true },
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
  /** Filter sidebar between the rail and the page (Guest issues). */
  subnav?: unknown;
  /** Buttons on the right of the top bar. */
  actions?: unknown;
  /** A toast with an Undo button that posts to `action`. */
  undo?: { text: string; action: string };
}

export interface Flash {
  text: string;
  tone?: "ok" | "err";
}

export function layout(title: string, body: unknown, opts: LayoutOpts = {}) {
  const staff = opts.nav !== false;
  const viewer = currentViewer();
  const nav = NAV.filter((n) => !("gm" in n) || isGm(viewer));
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
        <a class="skip" href="#main">Skip to content</a>
        ${staff
          ? html`<div class="app ${opts.subnav ? "has-subnav" : ""}">
              <nav class="rail" aria-label="Main">
                <div class="drag"></div>
                <a class="rail-logo" href="/issues" aria-label="Reviewloop home">${mark}</a>
                ${nav.map(
                  (n) => html`${n.href === "/upload" ? html`<i class="rail-sep"></i>` : ""}<a href="${n.href}" class="rail-item ${n.href === opts.active ? "on" : ""} ${n.href === "/hotels" || n.href === "/staff" ? "rail-desktop" : ""}" aria-label="${n.label}" data-label="${n.label}" data-tip="${n.label}" ${n.href === opts.active ? raw('aria-current="page"') : ""}
                    >${icon(n.icon)}<span class="rail-label" aria-hidden="true">${n.short}</span>${n.count ? html`<b class="rail-count" data-count="${n.count}" hidden></b>` : ""}</a
                  >`,
                )}
                <span class="rail-fill"></span>
                <button type="button" class="rail-item" id="rl-alerts" hidden aria-label="Turn on desktop alerts" data-tip="Turn on desktop alerts">${icon("bell")}</button>
                <form method="post" action="/logout"><button type="submit" class="rail-item" aria-label="${viewer?.device ? "Switch person" : "Sign out"}" data-tip="${viewer?.device ? "Switch person" : "Sign out"}">${icon(viewer?.device ? "users" : "out")}</button></form>
              </nav>
              ${opts.subnav ? html`<aside class="subnav">${opts.subnav}</aside>` : ""}
              <div class="main-col">
                <header class="topbar">
                  <h1>${title}</h1>
                  ${isDemo() ? html`<span class="demo-pill" title="Sample hotels and guests. Changes reset now and then.">Demo data</span>` : ""}
                  <span class="spacer"></span>
                  <button type="button" class="secondary ask-btn" data-ask aria-expanded="false" aria-controls="ask">${icon("spark")}<span>Ask Reviewloop</span></button>
                  ${opts.actions ?? ""}
                  ${viewer
                    ? accountMenu(viewer)
                    : html`<form method="post" action="/logout" class="topbar-out"><button type="submit" class="icon-btn" aria-label="Sign out">${icon("out")}</button></form>`}
                </header>
                <main class="content ${opts.wide ? "wide" : ""}" id="main" tabindex="-1">
                  ${opts.lede ? html`<p class="lede">${opts.lede}</p>` : ""}
                  ${body}
                </main>
              </div>
            </div>
            <aside class="ask" id="ask" aria-label="Ask Reviewloop" hidden>
              <header class="ask-head">
                <span class="ask-title">${icon("spark")} Ask Reviewloop</span>
                <button type="button" class="icon-btn" data-ask-close aria-label="Close">${icon("x")}</button>
              </header>
              <div class="ask-feed" id="ask-feed" aria-live="polite">
                <div class="ask-msg bot">
                  <p>Answers come straight from your live data. Try one:</p>
                  <div class="ask-chips">
                    <button type="button" data-topic="complaints">What are guests complaining about?</button>
                    <button type="button" data-topic="risk">Which issues are about to reach the GM?</button>
                    <button type="button" data-topic="reviews">How are reviews doing?</button>
                  </div>
                </div>
              </div>
              <form class="ask-input" id="ask-form">
                <input name="q" placeholder="Ask about issues, escalations or reviews…" autocomplete="off" aria-label="Ask a question" />
                <button type="submit" class="send" aria-label="Ask">${icon("send")}</button>
              </form>
            </aside>
            <button type="button" class="fresh" id="rl-fresh" hidden onclick="location.reload()">New guest activity · Refresh</button>
            <div class="sr-only" id="rl-live" role="status" aria-live="polite"></div>
            ${opts.flash ? html`<p class="toast ${opts.flash.tone ?? "ok"}" aria-hidden="true" data-announce>${opts.flash.text}</p>` : ""}
            ${opts.undo
              ? html`<form method="post" action="${opts.undo.action}" class="toast undo" data-announce>
                  ${opts.undo.text}<button type="submit" class="sm">Undo</button>
                </form>`
              : ""}
            <script>
              ${raw(GUARD_JS + STAFF_JS)}
            </script>
            ${deskIdle(viewer)}`
          : html`<main class="guest-main" id="main" tabindex="-1">
              <h1>${title}</h1>
              ${body}
              <p class="powered">${mark} Texts by Reviewloop</p>
            </main>
            <script>
              ${raw(GUARD_JS)}
            </script>`}
      </body>
    </html>`;
}

/** Shared <head>: fonts, tokens and PWA wiring. Also used by the login and landing pages. */
export function head(extraCss = "") {
  return html`<meta name="theme-color" content="#FFFFFF" />
    <meta name="color-scheme" content="light" />
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
      ${raw(CSS + ACCOUNT_CSS + extraCss)}
    </style>`;
}

// Every form submits once: a second click or Enter is ignored, the button says what is happening, and
// the live refresh on Guest issues waits (window.rlSubmitting). Buttons are disabled a tick later so
// the clicked button's formaction still applies. Coming back with the Back button re-enables them.
const GUARD_JS = `
(function () {
  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (e.defaultPrevented || f.method.toLowerCase() !== "post") return;
    if (f.dataset.busy) { e.preventDefault(); return; }
    f.dataset.busy = "1"; window.rlSubmitting = true;
    var b = e.submitter;
    setTimeout(function () {
      f.querySelectorAll("button").forEach(function (x) { x.disabled = true; });
      if (b) { b.setAttribute("aria-busy", "true"); if (b.dataset.busyText) { b.dataset.label = b.textContent; b.textContent = b.dataset.busyText; } }
    }, 0);
  });
  window.addEventListener("pageshow", function (e) {
    if (!e.persisted) return;
    window.rlSubmitting = false;
    document.querySelectorAll("form[data-busy]").forEach(function (f) {
      delete f.dataset.busy;
      f.querySelectorAll("button").forEach(function (x) { x.disabled = false; x.removeAttribute("aria-busy"); if (x.dataset.label) x.textContent = x.dataset.label; });
    });
  });
})();
`;

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
  // Screen readers miss text that is already on the page at load, so confirmations are announced
  // into a live region a moment later.
  var live = document.getElementById("rl-live"), toast = document.querySelector("[data-announce]");
  if (live && toast) setTimeout(function () { live.textContent = toast.textContent.replace(/\\s+/g, " ").replace(/Undo$/, "").trim(); }, 400);
  var NOUN = { unacked: "nobody on it", awaiting: "waiting for approval", problems: "need attention" };
  function apply(s) {
    document.querySelectorAll("[data-count]").forEach(function (el) {
      var v = s[el.getAttribute("data-count")] || 0;
      el.textContent = v > 99 ? "99+" : String(v);
      el.hidden = !v;
      // The count is part of the link's name: "Guest issues, 4 nobody on it".
      var item = el.closest("[data-label]");
      if (item) item.setAttribute("aria-label", item.getAttribute("data-label") + (v ? ", " + v + " " + NOUN[el.getAttribute("data-count")] : ""));
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
  // Ask Reviewloop panel. Answers are built with textContent only: they can contain guest text.
  var ask = document.getElementById("ask");
  if (ask) {
    var feed = document.getElementById("ask-feed"), form = document.getElementById("ask-form");
    var opener = null;
    var toggle = function (open) {
      ask.hidden = !open; ask.classList.toggle("open", open);
      document.querySelectorAll("[data-ask]").forEach(function (b) { b.setAttribute("aria-expanded", String(open)); });
      if (open) form.q.focus();
      else if (opener) { opener.focus(); opener = null; }
    };
    document.querySelectorAll("[data-ask]").forEach(function (b) { b.addEventListener("click", function () { if (ask.hidden) opener = b; toggle(ask.hidden); }); });
    ask.querySelector("[data-ask-close]").addEventListener("click", function () { toggle(false); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !ask.hidden) toggle(false); });
    var el = function (tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
    var bubble = function (cls, child) {
      var d = el("div", "ask-msg " + cls);
      if (typeof child === "string") d.textContent = child; else d.appendChild(child);
      feed.appendChild(d); feed.scrollTop = feed.scrollHeight; return d;
    };
    var render = function (a) {
      var box = el("div", "ask-card");
      box.appendChild(el("p", "ask-card-title", a.title));
      box.appendChild(el("p", "ask-lead", a.lead));
      if (a.bars && a.bars.length) {
        var max = Math.max.apply(null, a.bars.map(function (b) { return b.value; }));
        var bars = el("div", "ask-bars");
        a.bars.forEach(function (b) {
          var r = el("div", "ask-bar"); r.appendChild(el("span", "", b.label));
          var track = el("i"); var fill = el("b"); fill.style.width = Math.max(4, (100 * b.value) / max) + "%"; track.appendChild(fill);
          r.appendChild(track); r.appendChild(el("em", "", String(b.value))); bars.appendChild(r);
        });
        box.appendChild(bars);
      }
      if (a.items && a.items.length) {
        var ul = el("ul", "ask-items");
        a.items.forEach(function (it) {
          var li = el("li");
          if (it.href) { var link = el("a", "", it.text); link.href = it.href; li.appendChild(link); } else li.textContent = it.text;
          ul.appendChild(li);
        });
        box.appendChild(ul);
      }
      if (a.followups && a.followups.length) {
        var chips = el("div", "ask-chips");
        a.followups.forEach(function (f) { var b = el("button", "", f.label); b.type = "button"; b.dataset.topic = f.topic; chips.appendChild(b); });
        box.appendChild(chips);
      }
      return box;
    };
    var asked = function (text, params) {
      bubble("me", text);
      var wait = bubble("bot typing", "Looking…");
      fetch("/api/ask?" + new URLSearchParams(params), { headers: { accept: "application/json" }, credentials: "same-origin" })
        .then(function (r) { return r.json(); })
        .then(function (a) { wait.remove(); bubble("bot", render(a)); })
        .catch(function () { wait.textContent = "Couldn’t load that right now."; });
    };
    feed.addEventListener("click", function (e) {
      var t = e.target.closest("[data-topic]");
      if (t) asked(t.textContent, { topic: t.dataset.topic });
    });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var q = form.q.value.trim(); if (!q) return;
      form.q.value = ""; asked(q, { q: q });
    });
  }
  // Menus and popovers (<details>): Escape closes and returns focus, a click outside closes.
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    document.querySelectorAll("details[open]").forEach(function (d) { d.open = false; var s = d.querySelector("summary"); if (s) s.focus(); });
  });
  document.addEventListener("click", function (e) {
    document.querySelectorAll("details[open]").forEach(function (d) { if (!d.contains(e.target)) d.open = false; });
  });
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("/sw.js").catch(function () {});
})();
`;

const CSS = `
:root {
  --paper:#FFFFFF; --surface:#FFFFFF; --sunk:#F7F6F6; --bone:#F1F0EF; --ink:#29251E; --ink-2:rgba(41,37,30,.8); --muted:#66625B; --faint:#736F68; --accent:#3E7BFA;
  --line:#E8E4DC; --line-2:#D9D4CA; --hover:rgba(41,37,30,.045); --press:rgba(41,37,30,.08);
  --warn:#A8402B; --warn-bg:#FBEEE9; --warn-line:#EBC2B5; --warn-on-ink:#F2B5A5; --ok:#3B6B45; --ok-bg:#EDF4EC; --gold:#A8762A;
  --shadow:0 1px 0 rgba(41,37,30,.04), 0 1px 2px rgba(41,37,30,.06);
  --shadow-2:0 1px 0 rgba(41,37,30,.04), 0 8px 24px -8px rgba(41,37,30,.14);
  --shadow-3:0 1px 2px rgba(41,37,30,.05), 0 24px 48px -28px rgba(41,37,30,.3);
  --ring:0 0 0 1px rgba(41,37,30,.07), 0 1px 2px rgba(41,37,30,.08); --tip:rgba(41,37,30,.92);
  --display:"Instrument Sans", "Inter", ui-sans-serif, system-ui, sans-serif;
  --ui:"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --glass:rgba(255,255,255,.58); --glass-strong:rgba(255,255,255,.74); --glass-edge:rgba(255,255,255,.7);
  --glass-shadow:inset 0 1px 0 rgba(255,255,255,.9), inset 0 -1px 0 rgba(255,255,255,.25), 0 1px 2px rgba(41,37,30,.06), 0 12px 32px -14px rgba(41,37,30,.28);
  /* Type scale: five UI steps and four display steps. 10px is only for count badges. */
  --fs-xs:11px; --fs-sm:12px; --fs-md:13px; --fs-base:14px; --fs-lg:15px; --fs-d1:18px; --fs-d2:22px; --fs-d3:28px; --fs-d4:32px;
  --r-xs:6px; --r-sm:8px; --r-md:10px; --r:12px; --r-lg:16px; --r-xl:20px; --r-pill:999px; --ease:cubic-bezier(.2,.7,.2,1);
  color-scheme: light;
}
* { box-sizing:border-box; }
/* Liquid glass: frosted, saturated, with a bright top edge. Only over color or moving content. */
.glass { background:var(--glass); -webkit-backdrop-filter:blur(22px) saturate(180%); backdrop-filter:blur(22px) saturate(180%); border:1px solid var(--glass-edge); box-shadow:var(--glass-shadow); }
[hidden] { display:none !important; }
html { -webkit-text-size-adjust:100%; }
body { margin:0; background:var(--paper); color:var(--ink); font:var(--fs-base)/1.55 var(--ui); font-feature-settings:"cv11","ss01"; -webkit-font-smoothing:antialiased; }
a { color:inherit; }
h1, h2, h3 { font-weight:400; }
::selection { background:var(--ink); color:var(--paper); }
:focus-visible { outline:2px solid var(--ink); outline-offset:2px; border-radius:6px; }
.i { width:16px; height:16px; flex:none; }
.sr-only { position:absolute !important; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }
.skip { position:fixed; left:12px; top:-60px; z-index:50; padding:10px 14px; border-radius:var(--r-sm); background:var(--ink); color:var(--paper); font-weight:500; text-decoration:none; }
.skip:focus { top:12px; }
main:focus { outline:none; }
.mark { width:22px; height:22px; flex:none; }

/* ---------- Shell: icon rail, optional filter sidebar, top bar */
.app { display:grid; grid-template-columns:60px minmax(0,1fr); min-height:100vh; }
.app.has-subnav { grid-template-columns:60px 236px minmax(0,1fr); }
.drag { display:none; }
.rail { position:sticky; top:0; z-index:6; height:100vh; display:flex; flex-direction:column; align-items:center; gap:4px; padding:12px 0 14px; background:var(--sunk); border-right:1px solid var(--line); }
.rail form { margin:0; }
.rail-logo { display:grid; place-items:center; width:34px; height:34px; margin-bottom:14px; border-radius:var(--r-md); background:var(--ink); color:var(--paper); box-shadow:inset 0 1px 0 rgba(255,255,255,.14), 0 1px 2px rgba(41,37,30,.25); transition:transform .16s var(--ease); }
.rail-logo:hover { transform:translateY(-1px); }
.rail-logo .mark { width:20px; height:20px; }
.rail-item { position:relative; display:grid; place-items:center; width:38px; height:38px; padding:0; border:0; border-radius:var(--r-md); background:none; color:var(--muted); cursor:pointer; transition:background .16s var(--ease), color .16s var(--ease); box-shadow:none; }
.rail-item:hover { background:var(--hover); color:var(--ink); box-shadow:none; transform:none; }
.rail-item.on { background:var(--surface); color:var(--ink); box-shadow:var(--ring); }
.rail-label { display:none; }
.rail-item .i { width:18px; height:18px; }
.rail-item[data-tip]:hover::after, .rail-item[data-tip]:focus-visible::after { content:attr(data-tip); position:absolute; left:calc(100% + 10px); top:50%; transform:translateY(-50%); z-index:40; padding:6px 9px; border-radius:var(--r-xs); background:var(--tip); color:var(--paper); font:500 var(--fs-sm)/1 var(--ui); white-space:nowrap; pointer-events:none; }
.rail-count { position:absolute; top:2px; right:1px; min-width:16px; height:16px; padding:0 4px; border-radius:var(--r-pill); background:var(--ink); color:var(--paper); font:600 10px/16px var(--ui); text-align:center; font-variant-numeric:tabular-nums; box-shadow:0 0 0 2px var(--sunk); }
.rail-count[data-count="awaiting"] { background:var(--muted); }
.rail-count[data-count="problems"] { background:var(--warn); }
.rail-sep { width:20px; height:1px; margin:8px 0; background:var(--line-2); }
.rail-fill { flex:1; }
.subnav { position:sticky; top:0; height:100vh; overflow-y:auto; padding:14px 10px 20px; background:var(--sunk); border-right:1px solid var(--line); }
.sn-title { margin:0; padding:9px 10px 16px; font:600 var(--fs-lg)/1 var(--ui); letter-spacing:-.01em; }
.sn-item { display:flex; align-items:center; gap:10px; padding:7px 10px; border-radius:var(--r-sm); color:var(--ink-2); text-decoration:none; font-size:var(--fs-base); font-weight:500; transition:background .14s var(--ease); }
.sn-item span:not(.sn-ico):not(.sn-dot) { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sn-item:hover { background:var(--hover); }
.sn-item.on { background:var(--surface); color:var(--ink); box-shadow:var(--ring); }
.sn-item b { font-weight:500; font-size:var(--fs-md); color:var(--muted); font-variant-numeric:tabular-nums; }
.sn-item.hot b { color:var(--warn); font-weight:600; }
.sn-ico { display:grid; place-items:center; color:var(--muted); } .sn-ico .i { width:16px; height:16px; }
.sn-dot { position:relative; width:16px; height:16px; border-radius:var(--r-xs); background:var(--c); flex:none; }
.sn-dot::after { content:""; position:absolute; inset:5px; border-radius:50%; background:rgba(255,255,255,.9); }
.sn-label { margin:0; padding:18px 10px 6px; font-size:var(--fs-sm); color:var(--muted); }
.main-col { display:flex; flex-direction:column; min-width:0; min-height:100vh; }
.topbar { position:sticky; top:0; z-index:5; display:flex; align-items:center; gap:10px; height:56px; padding:0 20px; background:rgba(255,255,255,.78); -webkit-backdrop-filter:blur(20px) saturate(180%); backdrop-filter:blur(20px) saturate(180%); border-bottom:1px solid var(--line); }
.topbar h1 { margin:0; font:500 var(--fs-lg)/1 var(--ui); letter-spacing:-.01em; }
.topbar .btn, .topbar button, .topbar summary.btn { padding:8px 12px; font-size:var(--fs-md); }
.topbar-out { display:none; margin:0; }
.topbar .i { width:15px; height:15px; }
.ask-btn { gap:7px; }
.demo-pill { padding:3px 8px; border:1px dashed var(--line-2); border-radius:var(--r-pill); color:var(--muted); font-size:var(--fs-sm); white-space:nowrap; }
.content { width:100%; max-width:1080px; padding:28px clamp(16px, 3vw, 40px) 72px; }
.content > .lede:first-child { margin:0 0 24px; }
.content.wide { max-width:none; padding:0; flex:1; display:flex; flex-direction:column; min-height:0; }
.app:has(.content.wide) .main-col { height:100vh; }
.icon-btn { display:grid; place-items:center; width:30px; height:30px; padding:0; border-radius:var(--r-sm); border:1px solid var(--line); background:var(--surface); color:var(--muted); text-decoration:none; cursor:pointer; box-shadow:none; }
.icon-btn:hover { color:var(--ink); background:var(--sunk); box-shadow:none; }
.icon-btn .i { width:15px; height:15px; }
.desktop-darwin .rail { padding-top:42px; }
.desktop-darwin .subnav { padding-top:34px; }
.desktop-darwin .topbar { -webkit-app-region:drag; }
.desktop-darwin .topbar :is(a, button, summary, input, form, details) { -webkit-app-region:no-drag; }

/* ---------- Headings */
h1 { font:400 clamp(30px, 4vw, 42px)/1.05 var(--display); letter-spacing:-.035em; margin:0; text-wrap:balance; }
.lede { color:var(--muted); max-width:62ch; margin:12px 0 0; font-size:var(--fs-base); }
h2 { display:flex; align-items:center; gap:12px; margin:36px 0 14px; font:500 var(--fs-xs)/1 var(--ui); letter-spacing:.09em; text-transform:uppercase; color:var(--muted); }
h2::after { content:""; flex:1; height:1px; background:var(--line); }
.content > h2:first-child, .content > .lede + h2 { margin-top:8px; }

/* ---------- Stats */
/* Cell lines are drawn on each cell, so a short last row leaves white space, not a gray block. */
.stats { display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:0; margin:0 0 28px; background:var(--surface); border:1px solid var(--line); border-radius:var(--r); overflow:hidden; }
.stat { background:var(--surface); box-shadow:1px 0 0 var(--line), 0 1px 0 var(--line); padding:16px 18px 14px; color:var(--muted); font-size:var(--fs-md); line-height:1.35; }
.stat span { display:block; margin-bottom:6px; font:400 var(--fs-d4)/1 var(--display); letter-spacing:-.03em; color:var(--ink); font-variant-numeric:tabular-nums; }

/* ---------- Cards */
.card { position:relative; background:var(--surface); border:1px solid var(--line); border-radius:var(--r); padding:18px 20px; margin-bottom:12px; box-shadow:var(--shadow); transition:box-shadow .2s var(--ease), border-color .2s var(--ease); }
.card:hover { box-shadow:var(--shadow-2); }
.card.failed { border-color:var(--warn-line); }
.card.urgent { border-color:var(--warn-line); background:linear-gradient(var(--warn-bg), var(--warn-bg)), var(--surface); }
.card.urgent::before { content:""; position:absolute; left:-1px; top:14px; bottom:14px; width:3px; border-radius:0 3px 3px 0; background:var(--warn); }
.card header { display:flex; flex-wrap:wrap; align-items:center; gap:4px 8px; font-size:var(--fs-md); color:var(--muted); }
.card header strong { color:var(--ink); font-weight:600; }
.card header .meta { white-space:nowrap; }
.card > p { margin:10px 0; }
.issue-title { font:400 var(--fs-d2)/1.3 var(--display); letter-spacing:-.02em; margin:10px 0 4px; }
blockquote { margin:12px 0; padding:2px 0 2px 14px; border-left:2px solid var(--line-2); color:var(--ink-2); }
.stars { color:var(--gold); letter-spacing:1px; white-space:nowrap; } .stars i { font-style:normal; color:var(--faint); }

/* ---------- Forms */
textarea, input:not([type=checkbox]):not([type=radio]), select { width:100%; font:inherit; color:var(--ink); padding:9px 12px; border:1px solid var(--line-2); border-radius:var(--r-sm); background:var(--paper); transition:border-color .16s var(--ease), box-shadow .16s var(--ease); }
textarea { line-height:1.55; resize:vertical; }
textarea:focus, input:focus, select:focus { outline:none; border-color:var(--ink); box-shadow:0 0 0 3px var(--press); }
input[type=checkbox] { width:16px; height:16px; margin:2px 10px 0 0; accent-color:var(--ink); flex:none; }
input[type=file] { padding:7px; }
label { display:block; margin-bottom:14px; font-size:var(--fs-md); font-weight:500; color:var(--ink-2); }
label:has(> input[type=checkbox]) { display:flex; align-items:flex-start; font-weight:400; color:var(--muted); }
label > input, label > select, label > textarea { margin-top:6px; }
.actions, .inline { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; } .inline input { flex:1; min-width:200px; }
.actions form { margin:0; }
button, .btn { display:inline-flex; align-items:center; justify-content:center; gap:8px; font:500 var(--fs-base)/1 var(--ui); padding:10px 16px; border-radius:var(--r-sm); border:1px solid var(--ink); background:var(--ink); color:var(--paper); cursor:pointer; white-space:nowrap; text-decoration:none; transition:transform .16s var(--ease), background .16s var(--ease), box-shadow .16s var(--ease); }
button:hover, .btn:hover { box-shadow:0 4px 14px -6px rgba(41,37,30,.5); }
button:active, .btn:active { transform:translateY(1px); }
button.secondary, .btn.secondary { background:var(--surface); color:var(--ink); border-color:var(--line-2); }
button.secondary:hover, .btn.secondary:hover { background:var(--hover); box-shadow:none; }
button:disabled, button[aria-busy=true] { opacity:.6; cursor:progress; box-shadow:none; transform:none; }

/* ---------- Tags */
/* One status pill: .tag and .pill are the same component (.pill sits in list rows). */
.tag, .pill { display:inline-flex; align-items:center; gap:5px; padding:0 8px; border-radius:var(--r-pill); background:var(--bone); color:var(--ink-2); font:500 var(--fs-sm)/20px var(--ui); white-space:nowrap; }
.tag.err, .pill.err { color:var(--warn); background:var(--warn-bg); }
.tag.good, .pill.ok { color:var(--ok); background:var(--ok-bg); }
.tag.err::before, .tag.good::before { content:""; width:6px; height:6px; border-radius:50%; background:currentColor; }
.tag.good { color:var(--ok); background:var(--ok-bg); border-color:transparent; }
.tag.warn { color:var(--gold); background:var(--sunk); border-color:var(--line); }
.alerts { display:grid; gap:8px; margin:0 0 8px; }
.alert-line { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; margin:0; padding:12px 16px; border:1px solid var(--line); border-radius:var(--r); background:var(--surface); }
.err { color:var(--warn); } .good { color:var(--ok); }
.empty { padding:40px 20px; text-align:center; color:var(--muted); border:1px dashed var(--line-2); border-radius:var(--r); background:var(--surface); }
.muted { color:var(--muted); } .small { font-size:var(--fs-md); }
.spacer { flex:1; }
.form-card { max-width:560px; padding:22px 24px; }
button.wide { width:100%; padding:13px 16px; }
/* Small button: top bar, toasts, inline row actions. */
button.sm, .btn.sm { padding:7px 12px; font-size:var(--fs-md); }

/* ---------- Threads */
.thread { margin:14px 0; display:flex; flex-direction:column; gap:6px; }
.msg { max-width:78%; padding:8px 12px; border-radius:var(--r-lg); font-size:var(--fs-base); line-height:1.45; }
.msg.in { align-self:flex-start; background:var(--sunk); border-bottom-left-radius:4px; }
.msg.out { align-self:flex-end; background:var(--ink); color:var(--paper); border-bottom-right-radius:4px; }
.msg small { display:block; margin-top:3px; font-size:var(--fs-xs); opacity:.72; }

/* ---------- Tables */
.table-wrap { overflow-x:auto; border:1px solid var(--line); border-radius:var(--r); background:var(--surface); }
table { width:100%; border-collapse:collapse; font-size:var(--fs-md); font-variant-numeric:tabular-nums; }
td, th { text-align:left; padding:9px 12px; border-bottom:1px solid var(--line); white-space:nowrap; }
th { font-weight:500; color:var(--muted); font-size:var(--fs-sm); background:var(--sunk); }
tr:last-child td { border-bottom:0; }
.card table, main > table { border:1px solid var(--line); border-radius:var(--r); overflow:hidden; background:var(--surface); }

/* ---------- Guest pages */
.guest-main { max-width:460px; margin:0 auto; padding:48px 20px 40px; }
.guest-main h1 { margin-bottom:12px; }
.narrow { max-width:440px; margin:0 auto; }
.powered { display:flex; align-items:center; justify-content:center; gap:6px; margin-top:32px; color:var(--faint); font-size:var(--fs-sm); }
.powered .mark { width:16px; height:16px; }
.qr { background:#fff; padding:16px; display:inline-block; border-radius:var(--r); border:1px solid var(--line); }
.sign { text-align:center; padding:32px 20px; }
.sign h3 { font:400 var(--fs-d3)/1.1 var(--display); letter-spacing:-.03em; margin:0 0 8px; }

/* ---------- Metrics charts */
.charts { display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:12px; margin:0 0 12px; }
.chart { margin:0; padding:14px 16px 10px; border:1px solid var(--line); border-radius:var(--r); background:var(--surface); }
.chart figcaption { display:grid; grid-template-columns:1fr auto; align-items:baseline; gap:2px 8px; margin-bottom:8px; }
.chart figcaption span { font-size:var(--fs-md); color:var(--muted); }
.chart figcaption b { grid-row:span 2; font:400 var(--fs-d2)/1 var(--display); letter-spacing:-.03em; font-variant-numeric:tabular-nums; }
.chart figcaption small { font-size:var(--fs-xs); color:var(--faint); }
.chart svg { display:block; width:100%; height:auto; overflow:visible; }
.chart .bar { fill:var(--ink); opacity:.82; transition:opacity .12s var(--ease); }
.chart g.on .bar { opacity:1; }
.chart .zero { fill:var(--line-2); }
.chart-empty { display:grid; place-items:center; aspect-ratio:320/120; margin:0; border-bottom:1px solid var(--line-2); color:var(--faint); font-size:var(--fs-md); }
.chart .hit { fill:transparent; }
.chart .axis { stroke:var(--line-2); stroke-width:1; }
.chart .tick { font:var(--fs-xs) var(--ui); fill:var(--faint); font-variant-numeric:tabular-nums; }
.chart-tip { position:fixed; z-index:30; transform:translate(-50%, -100%); padding:5px 9px; border-radius:var(--r-xs); background:var(--ink); color:var(--paper); font-size:var(--fs-sm); pointer-events:none; white-space:nowrap; }
.table-details { margin-bottom:8px; }
.table-details summary { cursor:pointer; color:var(--muted); font-size:var(--fs-md); padding:6px 0 10px; }
.table-details summary:hover { color:var(--ink); }

/* ---------- Operations */
.all-clear { display:flex; align-items:center; gap:10px; padding:14px 16px; margin:0 0 8px; border:1px solid var(--line); border-radius:var(--r); background:var(--surface); color:var(--ink-2); }
.ok-line { margin:0; padding:12px 14px; border:1px dashed var(--line-2); border-radius:var(--r); color:var(--muted); font-size:var(--fs-base); }
td.clip { max-width:340px; overflow:hidden; text-overflow:ellipsis; }
td a { color:var(--ink); font-weight:500; text-underline-offset:2px; }
.fresh-list { display:grid; gap:1px; max-width:560px; margin:0 0 16px; border:1px solid var(--line); border-radius:var(--r); overflow:hidden; background:var(--line); }
.fresh-row { display:flex; flex-wrap:wrap; align-items:center; gap:8px 16px; padding:10px 14px; background:var(--surface); font-size:var(--fs-base); }
.fresh-row strong { flex:1; min-width:120px; font-weight:600; }
.fresh-item { display:inline-flex; align-items:center; gap:6px; color:var(--muted); }
.fresh-note { display:flex; flex-wrap:wrap; align-items:center; gap:6px 10px; }

/* ---------- Upload */
.kinds { border:0; padding:0; margin:0 0 16px; display:grid; gap:8px; }
.kinds legend { font-size:var(--fs-md); font-weight:500; color:var(--ink-2); margin-bottom:6px; padding:0; }
label.kind { display:flex; align-items:flex-start; gap:10px; margin:0; padding:10px 12px; border:1px solid var(--line-2); border-radius:var(--r-sm); cursor:pointer; font-weight:400; transition:border-color .16s var(--ease), background .16s var(--ease); }
label.kind:has(input:checked) { border-color:var(--ink); background:var(--sunk); }
label.kind input { width:16px; height:16px; margin:2px 0 0; accent-color:var(--ink); flex:none; }
label.kind span { display:flex; flex-direction:column; } label.kind strong { color:var(--ink); font-weight:500; } label.kind small { color:var(--muted); font-size:var(--fs-md); }
.drop { position:relative; display:flex; flex-direction:column; align-items:center; gap:6px; margin:0 0 16px; padding:22px 16px; border:1.5px dashed var(--line-2); border-radius:var(--r); text-align:center; cursor:pointer; transition:border-color .16s var(--ease), background .16s var(--ease); }
.drop:hover, .drop:focus-within { border-color:var(--ink); background:var(--sunk); }
.drop input { position:absolute; inset:0; opacity:0; cursor:pointer; margin:0; }
.drop-cta { display:inline-flex; align-items:center; gap:8px; font-weight:500; color:var(--ink); }
.drop[data-file]:not([data-file=""]) { border-style:solid; border-color:var(--ink); }
.drop[data-file]:not([data-file=""]) .drop-name { display:none; }
.drop[data-file]:not([data-file=""])::after { content:attr(data-file); font-size:var(--fs-md); color:var(--ink); }

/* ---------- Guest done + QR signs */
.done { padding:8px 0; } .done-title { margin:0 0 8px; font:400 var(--fs-d3)/1.1 var(--display); letter-spacing:-.03em; }
.sign { position:relative; }
.sign-print { position:absolute; top:14px; right:14px; }

/* ---------- Status chips (Operations) and the Log an issue popover */
.workbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:16px; }
.chip { display:inline-flex; align-items:baseline; gap:6px; padding:6px 11px; border-radius:var(--r-pill); background:var(--surface); border:1px solid var(--line); color:var(--muted); font-size:var(--fs-md); }
.chip b { font:400 var(--fs-d1)/1 var(--display); color:var(--ink); font-variant-numeric:tabular-nums; }
.chip.hot { border-color:var(--warn-line); background:var(--warn-bg); color:var(--warn); } .chip.hot b { color:var(--warn); }
.log { position:relative; }
.log summary { list-style:none; } .log summary::-webkit-details-marker { display:none; }
.pop { position:absolute; right:0; top:calc(100% + 8px); z-index:8; width:min(380px, calc(100vw - 32px)); padding:18px; border-radius:var(--r-lg); background:var(--glass-strong); -webkit-backdrop-filter:blur(24px) saturate(180%); backdrop-filter:blur(24px) saturate(180%); border:1px solid rgba(41,37,30,.08); box-shadow:var(--glass-shadow); }
.pop-title { margin:0 0 14px; font:400 var(--fs-d1)/1.2 var(--display); letter-spacing:-.02em; }

/* ---------- Guest issues inbox */
.tabsbar { display:flex; align-items:center; gap:2px; min-height:52px; padding:0 20px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
.tab { position:relative; display:flex; align-items:center; gap:7px; height:52px; padding:0 10px; color:var(--muted); text-decoration:none; font-size:var(--fs-base); font-weight:500; transition:color .14s var(--ease); }
.tab:hover { color:var(--ink); }
.tab.on { color:var(--ink); }
.tab.on::after { content:""; position:absolute; left:8px; right:8px; bottom:-1px; height:2px; border-radius:2px; background:var(--ink); }
.tab b { font-size:var(--fs-sm); font-weight:500; color:var(--faint); font-variant-numeric:tabular-nums; }
.tools { display:flex; align-items:center; gap:8px; margin-left:auto; padding:8px 0; }
.menu { position:relative; }
.menu summary { list-style:none; } .menu summary::-webkit-details-marker { display:none; }
.tool { display:inline-flex; align-items:center; gap:7px; padding:7px 10px; border-radius:var(--r-sm); color:var(--ink-2); font-size:var(--fs-md); font-weight:500; cursor:pointer; }
.tool:hover { background:var(--sunk); } .tool .i { width:15px; height:15px; }
.menu-pop { position:absolute; right:0; top:calc(100% + 6px); z-index:8; min-width:180px; padding:5px; border-radius:var(--r); background:var(--glass-strong); -webkit-backdrop-filter:blur(24px) saturate(180%); backdrop-filter:blur(24px) saturate(180%); border:1px solid rgba(41,37,30,.08); box-shadow:var(--glass-shadow); }
.menu-pop a { display:block; padding:7px 10px; border-radius:var(--r-xs); color:var(--ink-2); text-decoration:none; font-size:var(--fs-md); }
.menu-pop a:hover { background:var(--hover); }
.menu-pop p { margin:0; padding:8px 10px 4px; font-size:var(--fs-sm); color:var(--muted); }
.filter-menu { display:none; } .filter-menu .menu-pop { left:0; right:auto; } .menu-pop a.on { color:var(--ink); font-weight:600; }
.search { display:flex; align-items:center; gap:8px; width:min(300px, 40vw); height:36px; margin:0; padding:0 8px 0 11px; border:1px solid var(--line-2); border-radius:var(--r-md); background:var(--surface); color:var(--faint); transition:border-color .16s var(--ease), box-shadow .16s var(--ease); }
.search:focus-within { border-color:var(--ink); box-shadow:0 0 0 3px var(--press); }
.search .i { width:15px; height:15px; flex:none; }
.search input[name=q] { flex:1; min-width:0; padding:0; border:0; background:none; box-shadow:none; font-size:var(--fs-base); }
.search input[name=q]:focus { box-shadow:none; }
kbd { padding:1px 6px; border:1px solid var(--line-2); border-radius:var(--r-xs); font:500 var(--fs-xs)/16px var(--ui); color:var(--faint); background:var(--sunk); }
.banner { display:flex; flex-wrap:wrap; align-items:center; gap:4px 10px; margin:0; padding:11px 20px; border-bottom:1px solid var(--line); background:var(--sunk); font-size:var(--fs-base); }
.banner > .i { width:16px; height:16px; color:var(--muted); }
.banner.warn { background:var(--warn-bg); } .banner.warn > .i { color:var(--warn); }
.banner.ok { background:var(--ok-bg); } .banner.ok > .i { color:var(--ok); }
.banner a { color:var(--ink); font-weight:500; }
section.banner { display:block; }
.content > .banner, .report-check > .banner { margin:0 0 20px; border:1px solid var(--line); border-radius:var(--r); }
.content > .banner.warn, .report-check > .banner.warn { border-color:var(--warn-line); }

/* ---------- Hotel setup and report check */
.settings { max-width:640px; }
.settings fieldset { margin:0 0 22px; padding:0; border:0; }
.settings legend { margin:0 0 12px; padding:0; font:400 var(--fs-d1)/1.2 var(--display); letter-spacing:-.02em; color:var(--ink); }
.settings .hint { display:block; margin-top:2px; font-weight:400; color:var(--muted); font-size:var(--fs-md); }
.settings .hint a { color:var(--ink); }
.two { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:0 14px; }
.map-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:0 16px; }
.report-check .table-wrap { margin-bottom:8px; }
.banner-head { display:flex; flex-wrap:wrap; align-items:center; gap:4px 10px; }
.banner-head .i { width:16px; height:16px; color:var(--muted); }
.notice-row { display:grid; grid-template-columns:minmax(0,1.2fr) minmax(0,1fr) auto auto; align-items:center; gap:12px; padding:10px 0 0; margin-top:10px; border-top:1px solid var(--line); font-size:var(--fs-base); }
.check { display:flex; align-items:center; margin:0; font-weight:400; color:var(--ink-2); white-space:nowrap; }
.inbox-body { flex:1; display:grid; grid-template-columns:minmax(0,1fr); min-height:0; }
.inbox-body.has-sel { grid-template-columns:minmax(0,1fr) minmax(380px, 460px); }
.list { overflow-y:auto; min-height:0; }
.row { display:grid; grid-template-columns:8px 40px minmax(0,1fr) auto; align-items:center; gap:14px; padding:14px 20px 14px 14px; border-bottom:1px solid var(--line); color:inherit; text-decoration:none; transition:background .14s var(--ease); }
a.row:hover { background:var(--sunk); }
.row.on { background:var(--bone); }
.unread { width:7px; height:7px; border-radius:50%; }
.unread.is { background:var(--accent); box-shadow:0 0 0 3px rgba(62,123,250,.14); }
.avatar { position:relative; display:grid; place-items:center; width:40px; height:40px; border-radius:50%; flex:none; color:var(--ink); font:600 var(--fs-md)/1 var(--ui); letter-spacing:.02em; }
.avatar i { position:absolute; right:-2px; bottom:-2px; width:13px; height:13px; border-radius:4px; border:2px solid var(--surface); }
.row-main { min-width:0; display:flex; flex-direction:column; gap:3px; }
.row-top { display:flex; align-items:center; gap:8px; min-width:0; flex-wrap:wrap; }
.row-top strong { font-size:var(--fs-base); font-weight:600; }
.row-msg { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--ink-2); font-size:var(--fs-base); }
.row.quiet .row-msg { color:var(--muted); }
.list-hint { margin:0; padding:14px 20px; color:var(--muted); font-size:var(--fs-sm); }
.row-side { display:flex; flex-direction:column; align-items:flex-end; gap:3px; font-size:var(--fs-md); color:var(--muted); white-space:nowrap; font-variant-numeric:tabular-nums; }
.row-side span { color:var(--muted); }
.row-side .owner { color:var(--ok); } .row-side .owner.none { color:var(--warn); font-weight:500; }
.row-room { color:var(--muted); font-size:var(--fs-md); }
.pill .i { width:12px; height:12px; }
.panel { display:flex; flex-direction:column; min-height:0; margin:12px 12px 12px 0; border:1px solid var(--line); border-radius:var(--r-lg); background:var(--surface); box-shadow:var(--shadow-3); overflow:hidden; animation:panel .22s var(--ease); }
.panel:focus { outline:none; }
@keyframes panel { from { opacity:0; transform:translateX(10px); } to { opacity:1; transform:none; } }
.pane-head { display:flex; align-items:center; gap:12px; padding:14px 16px; border-bottom:1px solid var(--line); }
.pane-head > div { display:flex; flex-direction:column; flex:1; min-width:0; }
.pane-head strong { font-weight:600; font-size:var(--fs-lg); }
.pane-head .muted { font-size:var(--fs-md); }
.pane-tags { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px; }
.pane-body { flex:1; overflow-y:auto; padding:18px 20px; }
.pane-title { margin:0 0 4px; font:400 var(--fs-d2)/1.25 var(--display); letter-spacing:-.025em; text-wrap:balance; }
.pane-body .thread { margin-top:18px; }
.fixnote { margin:14px 0 0; padding:10px 12px; border-radius:var(--r-md); background:var(--ok-bg); font-size:var(--fs-base); } .fixnote b { display:block; font-weight:600; color:var(--ok); font-size:var(--fs-sm); margin-bottom:2px; }
.msg.failed { box-shadow:0 0 0 1.5px var(--warn); } .msg.failed b { color:var(--warn); font-weight:600; }
.msg.out.failed b { color:var(--warn-on-ink); }
.composer { padding:12px 14px 14px; border-top:1px solid var(--line); background:var(--surface); }
.compose { display:flex; gap:8px; align-items:flex-end; padding:6px 6px 6px 12px; border:1px solid var(--line-2); border-radius:var(--r-lg); transition:border-color .16s var(--ease), box-shadow .16s var(--ease); }
.compose:focus-within { border-color:var(--ink); box-shadow:0 0 0 3px var(--press); }
.compose textarea { flex:1; min-height:38px; max-height:140px; padding:6px 0; border:0; background:none; resize:none; box-shadow:none; }
.compose textarea:focus { box-shadow:none; }
.send { display:grid; place-items:center; width:32px; height:32px; padding:0; border-radius:50%; flex:none; }
.send .i { width:15px; height:15px; }
.pane-actions { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-top:10px; }
.pane-actions form { margin:0; }
.resolve { display:flex; gap:8px; flex:1; } .resolve input { flex:1; }
.zero { display:flex; flex-direction:column; align-items:center; max-width:420px; margin:56px auto; padding:0 20px; text-align:center; }
.zero-art { position:relative; width:260px; height:150px; margin-bottom:22px; border-radius:var(--r-lg); overflow:hidden; box-shadow:0 1px 2px rgba(41,37,30,.06), 0 18px 40px -22px rgba(26,40,52,.45);
  background:radial-gradient(60% 70% at 25% 15%, #A9DDF5, transparent 70%), radial-gradient(50% 60% at 85% 10%, #CBEBF7, transparent 70%), linear-gradient(180deg, #B8E2F2 0%, #DDEFF0 55%, #E9E3C8 100%); }
.zero-art::before, .zero-art::after, .zero-art i { content:""; position:absolute; border-radius:50%; }
.zero-art::before { left:-20%; right:30%; bottom:-55%; height:90%; background:radial-gradient(closest-side, #8FC48A, #A9D29A 60%, transparent); filter:blur(1px); }
.zero-art::after { left:35%; right:-25%; bottom:-60%; height:95%; background:radial-gradient(closest-side, #7DB67E, #9CCB8F 60%, transparent); }
.zero-art i { left:8%; right:8%; bottom:-30%; height:50%; background:radial-gradient(closest-side, rgba(242,181,98,.85), transparent); filter:blur(6px); }
.zero-title { margin:0 0 6px; font:400 var(--fs-d2)/1.15 var(--display); letter-spacing:-.03em; }
.zero .muted { margin:0; font-size:var(--fs-base); }
.zero.setup { align-items:stretch; text-align:left; max-width:520px; }
.steps { margin:20px 0 0; padding:0; list-style:none; counter-reset:step; display:grid; gap:10px; }
.steps li { counter-increment:step; display:grid; grid-template-columns:28px 1fr; gap:2px 12px; padding:14px 16px; border:1px solid var(--line); border-radius:var(--r); background:var(--surface); }
.steps li::before { content:counter(step); grid-row:span 2; display:grid; place-items:center; width:26px; height:26px; border-radius:50%; background:var(--sunk); font:600 var(--fs-sm)/1 var(--ui); color:var(--ink-2); }
.steps li.done::before { content:"✓"; background:var(--ok-bg); color:var(--ok); }
.steps b { font-weight:600; } .steps span { color:var(--muted); font-size:var(--fs-base); } .steps a { color:var(--ink); }
code { padding:1px 5px; border-radius:var(--r-xs); background:var(--sunk); font:var(--fs-md) ui-monospace, SFMono-Regular, Menlo, monospace; }

/* ---------- Ask Reviewloop: a glass panel over the page */
.ask { position:fixed; right:16px; top:68px; bottom:16px; z-index:30; width:min(400px, calc(100vw - 32px)); display:flex; flex-direction:column; border-radius:var(--r-xl); background:rgba(255,255,255,.8); -webkit-backdrop-filter:blur(28px) saturate(180%); backdrop-filter:blur(28px) saturate(180%); border:1px solid rgba(41,37,30,.08); box-shadow:inset 0 1px 0 #fff, 0 2px 4px rgba(41,37,30,.05), 0 32px 64px -24px rgba(41,37,30,.35); animation:panel .22s var(--ease); }
.ask-head { display:flex; align-items:center; justify-content:space-between; padding:14px 14px 10px 18px; }
.ask-title { display:inline-flex; align-items:center; gap:8px; font-weight:600; font-size:var(--fs-base); } .ask-title .i { width:16px; height:16px; }
.ask-feed { flex:1; overflow-y:auto; display:flex; flex-direction:column; gap:10px; padding:6px 16px 16px; }
.ask-msg { font-size:var(--fs-base); line-height:1.5; }
.ask-msg.me { align-self:flex-end; max-width:85%; padding:9px 13px; border-radius:var(--r-lg); background:var(--sunk); }
.ask-msg.bot p { margin:0 0 10px; color:var(--ink-2); }
.ask-msg.typing { color:var(--faint); }
.ask-card { padding:14px; border:1px solid var(--line); border-radius:var(--r); background:var(--surface); }
.ask-card-title { margin:0 0 4px !important; font-weight:600; color:var(--ink) !important; }
.ask-lead { margin:0 0 12px !important; }
.ask-bars { display:grid; gap:8px; margin-bottom:12px; }
.ask-bar { display:grid; grid-template-columns:96px 1fr 26px; align-items:center; gap:10px; font-size:var(--fs-md); }
.ask-bar span { color:var(--ink-2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ask-bar i { height:8px; border-radius:4px; background:var(--sunk); overflow:hidden; } .ask-bar b { display:block; height:100%; border-radius:4px; background:var(--ink); }
.ask-bar em { font-style:normal; text-align:right; color:var(--muted); font-variant-numeric:tabular-nums; }
.ask-items { margin:0 0 12px; padding:0; list-style:none; display:grid; gap:6px; font-size:var(--fs-md); }
.ask-items li { padding:8px 10px; border-radius:var(--r-sm); background:var(--sunk); }
.ask-items a { color:var(--ink); text-decoration:none; } .ask-items a:hover { text-decoration:underline; }
.ask-chips { display:flex; flex-direction:column; align-items:flex-start; gap:6px; }
.ask-chips button { padding:7px 11px; border-radius:var(--r-pill); background:var(--surface); color:var(--ink); border:1px solid var(--line-2); font-size:var(--fs-md); font-weight:500; box-shadow:none; white-space:normal; text-align:left; }
.ask-chips button:hover { background:var(--sunk); box-shadow:none; }
.ask-input { display:flex; align-items:center; gap:8px; margin:0 12px 12px; padding:6px 6px 6px 14px; border:1px solid var(--line-2); border-radius:var(--r-lg); background:var(--surface); }
.ask-input:focus-within { border-color:var(--ink); box-shadow:0 0 0 3px var(--press); }
.ask-input input { flex:1; border:0; padding:6px 0; background:none; box-shadow:none; } .ask-input input:focus { box-shadow:none; }

.fresh { position:fixed; left:50%; bottom:20px; transform:translateX(-50%); z-index:20; border-radius:var(--r-pill); background:rgba(41,37,30,.78); -webkit-backdrop-filter:blur(18px) saturate(160%); backdrop-filter:blur(18px) saturate(160%); border:1px solid rgba(255,255,255,.14); box-shadow:var(--shadow-2); }
.toast { position:fixed; left:50%; bottom:20px; transform:translateX(-50%); z-index:21; margin:0; padding:10px 16px; border-radius:var(--r-pill); background:rgba(41,37,30,.78); -webkit-backdrop-filter:blur(18px) saturate(160%); backdrop-filter:blur(18px) saturate(160%); border:1px solid rgba(255,255,255,.14); color:#fff; font-size:var(--fs-base); box-shadow:var(--shadow-2); animation:toast 4.5s var(--ease) forwards; pointer-events:none; max-width:calc(100vw - 32px); }
.toast.err { background:var(--warn); color:#fff; }
.toast.undo { display:flex; align-items:center; gap:14px; padding:6px 6px 6px 16px; pointer-events:auto; animation-duration:9s; }
.toast.undo button { padding:7px 12px; border-radius:var(--r-pill); background:var(--surface); color:var(--ink); border-color:var(--surface); font-size:var(--fs-md); }
@keyframes toast { 0% { opacity:0; transform:translate(-50%, 8px); } 6%, 85% { opacity:1; transform:translate(-50%, 0); } 100% { opacity:0; transform:translate(-50%, 4px); visibility:hidden; } }

@media (max-width: 1100px) {
  .app.has-subnav { grid-template-columns:60px minmax(0,1fr); }
  .subnav { display:none; }
  .filter-menu { display:block; }
  .inbox-body.has-sel { grid-template-columns:minmax(0,1fr); }
  .inbox-body.has-sel .list { display:none; }
  .panel { margin:12px; }
}

@media (max-width: 760px) {
  .app, .app.has-subnav { display:block; padding-bottom:64px; }
  .rail { position:fixed; inset:auto 0 0 0; top:auto; height:60px; flex-direction:row; justify-content:space-around; padding:0 8px env(safe-area-inset-bottom); border-right:0; border-top:1px solid var(--line); background:rgba(247,246,246,.85); -webkit-backdrop-filter:blur(20px) saturate(180%); backdrop-filter:blur(20px) saturate(180%); }
  .rail-logo, .rail-sep, .rail-fill, #rl-alerts, .rail form, .rail-desktop { display:none !important; }
  .rail-item { width:auto; flex:1; height:52px; gap:3px; align-content:center; text-decoration:none; }
  .rail-item.on .rail-label { font-weight:600; }
  .rail-label { display:block; font:500 10px/1 var(--ui); white-space:nowrap; }
  .rail-item.on { background:none; box-shadow:none; }
  .rail-count { right:calc(50% - 22px); }
  .rail-item[data-tip]:hover::after, .rail-item[data-tip]:focus-visible::after { display:none; }
  .topbar-out { display:block; }
  .main-col, .app:has(.content.wide) .main-col { height:auto; min-height:calc(100vh - 60px); }
  .topbar { padding:0 12px; }
  .stats { grid-template-columns:1fr 1fr; }
  .stat:last-child:nth-child(odd) { grid-column:1 / -1; }
  .topbar .btn.sm span, .ask-btn span, .log summary span { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
  .content { padding:20px 16px 48px; }
  .tabsbar { padding:0 8px; }
  .tools { width:100%; margin:0; padding:0 4px 10px; }
  .tools { flex-wrap:wrap; }
  .search { flex:1 1 160px; width:auto; }
  .search kbd, .list-hint { display:none; }
  .row { grid-template-columns:6px 36px minmax(0,1fr) auto; gap:10px; padding:12px 12px 12px 8px; }
  .avatar { width:36px; height:36px; font-size:var(--fs-sm); }
  .row-side span:not(.owner) { display:none; }
  .panel { margin:0; border-radius:0; border-width:0; box-shadow:none; }
  .pane-body { overflow:visible; }
  .composer { position:sticky; bottom:60px; }
  .notice-row { grid-template-columns:1fr; gap:6px; }
  .banner { padding:10px 12px; }
  .ask { top:auto; bottom:72px; height:min(70vh, 560px); right:8px; width:calc(100vw - 16px); }
  .msg { max-width:90%; }
  .pop { position:fixed; left:12px; right:12px; top:64px; width:auto; }
}
@media (prefers-reduced-motion: reduce) { * { transition:none !important; animation:none !important; } }
@media print { body[data-print] .sign:not(.print-me) { display:none; } .sign { break-after:page; border:0; } .sign:last-child { break-after:auto; }
  .topbar, .rail, .subnav, .ask, .content > .lede, .noprint, .toast, .fresh { display:none !important; } .card { box-shadow:none; break-inside:avoid; } }
`;
