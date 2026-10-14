import { html, raw } from "hono/html";

export const stars = (n: number | null) => (n ? "★".repeat(n) + "☆".repeat(5 - n) : "No rating");
export const statBox = (label: string, value: string) => html`<div class="stat"><span>${value}</span>${label}</div>`;

export function timeAgo(d: Date | string | null, now = new Date()): string {
  if (!d) return "";
  const min = Math.round((now.getTime() - new Date(d).getTime()) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} days ago`;
}

export function layout(title: string, body: unknown, opts: { head?: unknown; nav?: boolean } = {}) {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} · Reviewloop</title>
        <style>
          ${raw(CSS)}
        </style>
        ${opts.head ?? ""}
      </head>
      <body>
        ${opts.nav === false
          ? ""
          : html`<nav>
              <b>Reviewloop</b><a href="/issues">Guest issues</a><a href="/">Review replies</a><a href="/metrics">Pilot metrics</a
              ><a href="/upload">Upload report</a><a href="/setup">Check-in QR</a>
            </nav>`}
        <main>
          <h1>${title}</h1>
          ${body}
        </main>
      </body>
    </html>`;
}

const CSS = `
:root { --bg:#f7f6f3; --card:#fff; --ink:#1d1d1b; --muted:#6b6a65; --line:#e3e1db; --accent:#1f5f4a; --warn:#a33a2b; --warnbg:#fbeeeb; --ok:#2d6a3e; }
@media (prefers-color-scheme: dark) { :root { --bg:#161615; --card:#1f1f1d; --ink:#ecebe6; --muted:#9a998f; --line:#33322e; --accent:#5fb394; --warn:#e07a6a; --warnbg:#2c1d1a; --ok:#7cc38f; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 system-ui, sans-serif; }
nav { display:flex; gap:18px; align-items:center; padding:14px 16px; border-bottom:1px solid var(--line); background:var(--card); flex-wrap:wrap; }
nav a { color:var(--muted); text-decoration:none; } nav a:hover { color:var(--ink); }
main { max-width:900px; margin:0 auto; padding:16px; }
h1 { font-size:22px; margin:8px 0 16px; } h2 { font-size:17px; margin:22px 0 10px; }
.stats { display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:10px; margin-bottom:18px; }
.stat { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px 12px; color:var(--muted); font-size:13px; }
.stat span { display:block; font-size:24px; color:var(--ink); font-weight:600; }
.card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:14px; margin-bottom:14px; }
.card.failed, .card.urgent { border-color:var(--warn); }
.card.urgent { background:var(--warnbg); }
.card header { font-size:14px; color:var(--muted); } .card header strong { color:var(--ink); }
blockquote { margin:10px 0; padding-left:12px; border-left:3px solid var(--line); }
textarea, input, select { width:100%; font:inherit; padding:8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--ink); }
input[type=checkbox] { width:auto; margin-right:8px; }
label { display:block; margin-bottom:10px; font-size:14px; color:var(--muted); }
.actions, .inline { display:flex; gap:8px; margin-top:8px; flex-wrap:wrap; } .inline input { flex:1; min-width:180px; }
button { font:inherit; padding:8px 14px; border-radius:6px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; white-space:nowrap; }
button.secondary { background:transparent; color:var(--ink); border-color:var(--line); }
.tag { margin-left:6px; font-size:12px; padding:1px 6px; border-radius:4px; border:1px solid var(--line); white-space:nowrap; }
.err { color:var(--warn); border-color:var(--warn); } .good { color:var(--ok); }
.empty, .muted { color:var(--muted); }
.thread { margin:10px 0; display:flex; flex-direction:column; gap:6px; }
.msg { max-width:80%; padding:6px 10px; border-radius:10px; font-size:14px; border:1px solid var(--line); }
.msg.in { align-self:flex-start; background:var(--bg); } .msg.out { align-self:flex-end; background:var(--card); }
.msg small { display:block; color:var(--muted); font-size:11px; }
.table-wrap { overflow-x:auto; }
table { width:100%; border-collapse:collapse; background:var(--card); font-size:14px; } td, th { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); white-space:nowrap; }
.narrow { max-width:440px; margin:0 auto; }
.qr { background:#fff; padding:16px; display:inline-block; border-radius:8px; }
@media print { nav, .noprint { display:none; } }
`;
