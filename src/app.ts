import { Hono, type Context } from "hono";
import { basicAuth } from "hono/basic-auth";
import { html, raw } from "hono/html";
import type { Db } from "./db.js";
import { parseAsiReport, parseMapping, REPORT_KINDS, type ReportKind } from "./ingest/asiReport.js";
import { reconcile } from "./ingest/reconcile.js";
import type { Messenger } from "./messaging.js";
import { processEvents, runDueJobs } from "./milestones/engine.js";
import { getProperty, listProperties } from "./properties.js";
import type { ReplyDrafter } from "./reviews/drafter.js";
import type { ReviewSource } from "./reviews/sources.js";
import { approveDraft, dismissDraft, syncReviews } from "./reviews/sync.js";

export interface AppDeps {
  db: Db;
  messenger: Messenger;
  source: ReviewSource;
  drafter: ReplyDrafter;
  now?: () => Date;
  adminUser?: string;
  adminPassword?: string;
  cronSecret?: string;
}

type Env = { Variables: { user: string } };

export function createApp(deps: AppDeps) {
  const { db } = deps;
  const app = new Hono<Env>();

  // Machine endpoints: bearer token. Vercel Cron sends "Authorization: Bearer $CRON_SECRET".
  const requireSecret = async (c: Context<Env>, next: () => Promise<void>) => {
    if (!deps.cronSecret || c.req.header("authorization") !== `Bearer ${deps.cronSecret}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };

  app.get("/cron/tick", requireSecret, async (c) => c.json(await tick(deps)));

  // For automated report delivery (e.g. an ASI scheduled report forwarded to this URL).
  app.post("/api/ingest/:propertyId", requireSecret, async (c) => {
    const kind = c.req.query("kind") as ReportKind;
    if (!REPORT_KINDS.includes(kind)) return c.json({ error: `kind must be one of ${REPORT_KINDS.join(", ")}` }, 400);
    return c.json(await ingest(deps, c.req.param("propertyId") ?? "", kind, await c.req.text()));
  });

  // Staff UI: basic auth. The username is recorded as the approver.
  app.use("/*", async (c, next) => {
    if (!deps.adminPassword) {
      c.set("user", "admin");
      return next();
    }
    const auth = basicAuth({ username: deps.adminUser ?? "admin", password: deps.adminPassword });
    await auth(c, async () => {
      c.set("user", deps.adminUser ?? "admin");
      await next();
    });
  });

  app.get("/", async (c) => {
    const queue = await db.query<QueueRow>(
      `select d.id::text, d.draft, d.status, d.error, r.author, r.rating, r.body, r.reviewed_at, r.source,
              p.name as property, s.confirmation
         from reply_drafts d join reviews r on r.id = d.review_id join properties p on p.id = r.property_id
         left join stays s on s.id = r.stay_id
        where d.status in ('pending', 'failed') order by r.reviewed_at`,
    );
    const stats = await db.query<{ k: string; n: string }>(
      `select 'requests_7d' as k, count(*)::text as n from review_requests where sent_at > now() - interval '7 days'
       union all select 'jobs_pending', count(*)::text from jobs where status = 'pending'
       union all select 'posted_7d', count(*)::text from reply_drafts where posted_at > now() - interval '7 days'
       union all select 'open_cases', count(*)::text from recovery_cases where resolved_at is null`,
    );
    const stat = Object.fromEntries(stats.map((s) => [s.k, s.n]));
    return c.html(
      layout(
        "Approval queue",
        html`
          <div class="stats">
            ${statBox("Awaiting you", String(queue.length))} ${statBox("Requests sent, 7 days", stat.requests_7d ?? "0")}
            ${statBox("Replies posted, 7 days", stat.posted_7d ?? "0")} ${statBox("Open guest issues", stat.open_cases ?? "0")}
          </div>
          ${queue.length === 0 ? html`<p class="empty">Nothing to approve. New reviews show up here after the next sync.</p>` : ""}
          ${queue.map(
            (q) => html`
              <article class="card ${q.status}">
                <header>
                  <strong>${q.property}</strong> · ${stars(q.rating)} · ${q.author ?? "Anonymous"} ·
                  ${new Date(q.reviewed_at).toLocaleDateString("en-US")}
                  ${q.confirmation ? html`<span class="tag">Stay ${q.confirmation}</span>` : ""}
                  ${q.status === "failed" ? html`<span class="tag err">Post failed: ${q.error}</span>` : ""}
                </header>
                <blockquote>${q.body ?? "(rating only)"}</blockquote>
                <form method="post" action="/drafts/${q.id}/approve">
                  <textarea name="text" rows="5">${q.draft}</textarea>
                  <div class="actions">
                    <button type="submit">Approve and post</button>
                    <button type="submit" class="secondary" formaction="/drafts/${q.id}/dismiss">Dismiss</button>
                  </div>
                </form>
              </article>
            `,
          )}
        `,
      ),
    );
  });

  app.post("/drafts/:id/approve", async (c) => {
    const form = await c.req.parseBody();
    const res = await approveDraft(db, deps.source, c.req.param("id"), String(form.text ?? ""), c.get("user"));
    if (!res.ok) return c.html(layout("Not posted", html`<p class="err">${res.error}</p><a href="/">Back</a>`), 502);
    return c.redirect("/");
  });

  app.post("/drafts/:id/dismiss", async (c) => {
    await dismissDraft(db, c.req.param("id"), c.get("user"));
    return c.redirect("/");
  });

  app.get("/upload", async (c) => {
    const props = await listProperties(db);
    return c.html(
      layout(
        "Upload ASI report",
        html`
          <p>Export the report from ASI as CSV and upload it here. Re-uploading the same report is safe.</p>
          <form method="post" action="/upload" enctype="multipart/form-data" class="card">
            <label>Property <select name="property">${props.map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select></label>
            <label>Report <select name="kind">${REPORT_KINDS.map((k) => html`<option value="${k}">${k.replace("_", "-")}</option>`)}</select></label>
            <label>CSV file <input type="file" name="file" accept=".csv,text/csv" required /></label>
            <button type="submit">Import</button>
          </form>
        `,
      ),
    );
  });

  app.post("/upload", async (c) => {
    const form = await c.req.parseBody();
    const file = form.file;
    const kind = String(form.kind) as ReportKind;
    if (!(file instanceof File) || !REPORT_KINDS.includes(kind)) return c.text("missing file or report type", 400);
    const r = await ingest(deps, String(form.property), kind, await file.text());
    return c.html(
      layout(
        "Import complete",
        html`
          <div class="stats">
            ${statBox("New stays", String(r.created))} ${statBox("Updated", String(r.updated))}
            ${statBox("Unchanged", String(r.unchanged))} ${statBox("Rows with problems", String(r.rowErrors.length))}
          </div>
          ${r.rowErrors.length
            ? html`<table>
                <tr><th>Row</th><th>Problem</th></tr>
                ${r.rowErrors.map((e) => html`<tr><td>${e.row}</td><td>${e.message}</td></tr>`)}
              </table>`
            : ""}
          <p><a href="/upload">Upload another</a> · <a href="/">Approval queue</a></p>
        `,
      ),
    );
  });

  // Minimal guest-issue log. A open issue holds that guest's review request (max 48h after checkout).
  app.get("/issues", async (c) => {
    const open = await db.query<{ id: string; summary: string; confirmation: string; guest: string; property: string; opened_at: Date }>(
      `select c.id::text, c.summary, s.confirmation, concat_ws(' ', s.guest_first_name, s.guest_last_name) as guest,
              p.name as property, c.opened_at
         from recovery_cases c join stays s on s.id = c.stay_id join properties p on p.id = s.property_id
        where c.resolved_at is null order by c.opened_at`,
    );
    const guests = await db.query<{ id: string; label: string }>(
      `select s.id::text, concat(p.name, ' · ', coalesce(s.room, '?'), ' · ', concat_ws(' ', s.guest_first_name, s.guest_last_name),
                                ' (', s.confirmation, ')') as label
         from stays s join properties p on p.id = s.property_id
        where s.status = 'in_house' or (s.status = 'checked_out' and s.departure_date >= current_date - 2)
        order by p.name, s.room`,
    );
    return c.html(
      layout(
        "Guest issues",
        html`
          <form method="post" action="/issues" class="card">
            <label>Guest <select name="stay">${guests.map((g) => html`<option value="${g.id}">${g.label}</option>`)}</select></label>
            <label>What's wrong <input name="summary" required placeholder="AC not cooling" /></label>
            <button type="submit">Log issue</button>
          </form>
          ${open.map(
            (o) => html`
              <article class="card">
                <header><strong>${o.property}</strong> · ${o.guest} (${o.confirmation})</header>
                <p>${o.summary}</p>
                <form method="post" action="/issues/${o.id}/resolve" class="inline">
                  <input name="resolution" placeholder="How it was fixed" required />
                  <button type="submit">Resolve</button>
                </form>
              </article>
            `,
          )}
        `,
      ),
    );
  });

  app.post("/issues", async (c) => {
    const form = await c.req.parseBody();
    const summary = String(form.summary ?? "").trim();
    if (!summary) return c.text("summary required", 400);
    await db.query("insert into recovery_cases (stay_id, summary) values ($1, $2)", [String(form.stay), summary]);
    return c.redirect("/issues");
  });

  app.post("/issues/:id/resolve", async (c) => {
    const form = await c.req.parseBody();
    await db.query("update recovery_cases set resolved_at = now(), resolution = $2 where id = $1 and resolved_at is null", [
      c.req.param("id"),
      String(form.resolution ?? "").trim() || null,
    ]);
    return c.redirect("/issues");
  });

  return app;
}

/** One scheduler pass: apply new events, send due messages, sync reviews for every property. */
export async function tick(deps: AppDeps) {
  const events = await processEvents(deps.db);
  const jobs = await runDueJobs(deps.db, { messenger: deps.messenger, now: deps.now });
  const reviews: Record<string, unknown> = {};
  for (const p of await listProperties(deps.db)) {
    if (!deps.source.supports(p)) continue;
    try {
      reviews[p.id] = await syncReviews(deps.db, p.id, deps);
    } catch (err) {
      reviews[p.id] = { error: (err as Error).message };
    }
  }
  return { events, jobs, reviews };
}

export async function ingest(deps: AppDeps, propertyId: string, kind: ReportKind, csv: string) {
  const property = await getProperty(deps.db, propertyId);
  const parsed = parseAsiReport(csv, { kind, timezone: property.timezone, mapping: parseMapping(property.report_mapping) });
  const result = await reconcile(deps.db, property.id, parsed.reservations, deps.now?.() ?? new Date());
  await processEvents(deps.db);
  return { ...result, rows: parsed.reservations.length, rowErrors: parsed.errors };
}

interface QueueRow {
  id: string;
  draft: string;
  status: string;
  error: string | null;
  author: string | null;
  rating: number | null;
  body: string | null;
  reviewed_at: Date;
  source: string;
  property: string;
  confirmation: string | null;
}

const stars = (n: number | null) => (n ? "★".repeat(n) + "☆".repeat(5 - n) : "No rating");
const statBox = (label: string, value: string) => html`<div class="stat"><span>${value}</span>${label}</div>`;

function layout(title: string, body: unknown) {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} · Reviewloop</title>
        <style>
          ${raw(CSS)}
        </style>
      </head>
      <body>
        <nav><b>Reviewloop</b><a href="/">Approval queue</a><a href="/issues">Guest issues</a><a href="/upload">Upload report</a></nav>
        <main>
          <h1>${title}</h1>
          ${body}
        </main>
      </body>
    </html>`;
}

const CSS = `
:root { --bg:#f7f6f3; --card:#fff; --ink:#1d1d1b; --muted:#6b6a65; --line:#e3e1db; --accent:#1f5f4a; --warn:#a33a2b; }
@media (prefers-color-scheme: dark) { :root { --bg:#161615; --card:#1f1f1d; --ink:#ecebe6; --muted:#9a998f; --line:#33322e; --accent:#5fb394; --warn:#e07a6a; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 system-ui, sans-serif; }
nav { display:flex; gap:20px; align-items:center; padding:14px 16px; border-bottom:1px solid var(--line); background:var(--card); flex-wrap:wrap; }
nav a { color:var(--muted); text-decoration:none; } nav a:hover { color:var(--ink); }
main { max-width:860px; margin:0 auto; padding:16px; }
h1 { font-size:22px; margin:8px 0 16px; }
.stats { display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:10px; margin-bottom:18px; }
.stat { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px 12px; color:var(--muted); font-size:13px; }
.stat span { display:block; font-size:24px; color:var(--ink); font-weight:600; }
.card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:14px; margin-bottom:14px; }
.card.failed { border-color:var(--warn); }
.card header { font-size:14px; color:var(--muted); } .card header strong { color:var(--ink); }
blockquote { margin:10px 0; padding-left:12px; border-left:3px solid var(--line); }
textarea, input, select { width:100%; font:inherit; padding:8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--ink); }
label { display:block; margin-bottom:10px; font-size:14px; color:var(--muted); }
.actions, .inline { display:flex; gap:8px; margin-top:8px; }
button { font:inherit; padding:8px 14px; border-radius:6px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; white-space:nowrap; }
button.secondary { background:transparent; color:var(--ink); border-color:var(--line); }
.tag { margin-left:6px; font-size:12px; padding:1px 6px; border-radius:4px; border:1px solid var(--line); }
.err { color:var(--warn); border-color:var(--warn); }
.empty { color:var(--muted); }
table { width:100%; border-collapse:collapse; background:var(--card); } td, th { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); }
`;
