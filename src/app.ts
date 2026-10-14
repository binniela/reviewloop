import { Hono, type Context } from "hono";
import { basicAuth } from "hono/basic-auth";
import { html } from "hono/html";
import { linkPendingConsents, recordConsent } from "./consent.js";
import type { Db } from "./db.js";
import { classifierFromEnv, type Classifier } from "./inbound/classify.js";
import { acknowledgeCase, replyToGuest, resolveCase, runCaseTimers } from "./inbound/cases.js";
import { handleInbound } from "./inbound/handle.js";
import { validTwilioSignature } from "./inbound/twilioSignature.js";
import { parseAsiReport, parseMapping, REPORT_KINDS, type ReportKind } from "./ingest/asiReport.js";
import { reconcile } from "./ingest/reconcile.js";
import type { Messenger } from "./messaging.js";
import { processEvents, runDueJobs } from "./milestones/engine.js";
import { getProperty, listProperties } from "./properties.js";
import type { ReplyDrafter } from "./reviews/drafter.js";
import type { ReviewSource } from "./reviews/sources.js";
import { approveDraft, dismissDraft, syncReviews } from "./reviews/sync.js";
import { issuesPage } from "./web/issues.js";
import { layout, stars, statBox } from "./web/layout.js";
import { metricsPage } from "./web/metrics.js";
import { checkinDone, checkinForm, qrSign } from "./web/public.js";

export interface AppDeps {
  db: Db;
  messenger: Messenger;
  source: ReviewSource;
  drafter: ReplyDrafter;
  classifier?: Classifier;
  now?: () => Date;
  adminUser?: string;
  adminPassword?: string;
  cronSecret?: string;
  /** Twilio auth token, for verifying inbound webhooks. */
  twilioAuthToken?: string;
  /** Public base URL (https://...), needed for webhook verification and links in alerts. */
  publicUrl?: string;
  /** Development only: accept unsigned Twilio webhooks. */
  allowUnsignedWebhooks?: boolean;
}

type Env = { Variables: { user: string } };

export function createApp(deps: AppDeps) {
  const { db } = deps;
  const app = new Hono<Env>();
  const now = () => deps.now?.() ?? new Date();
  const classifier = deps.classifier ?? classifierFromEnv();

  // ---------- Machine endpoints (bearer token; Vercel Cron sends "Authorization: Bearer $CRON_SECRET")
  const requireSecret = async (c: Context<Env>, next: () => Promise<void>) => {
    if (!deps.cronSecret || c.req.header("authorization") !== `Bearer ${deps.cronSecret}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };

  app.get("/cron/tick", requireSecret, async (c) => c.json(await tick(deps)));

  app.post("/api/ingest/:propertyId", requireSecret, async (c) => {
    const kind = c.req.query("kind") as ReportKind;
    if (!REPORT_KINDS.includes(kind)) return c.json({ error: `kind must be one of ${REPORT_KINDS.join(", ")}` }, 400);
    return c.json(await ingest(deps, c.req.param("propertyId") ?? "", kind, await c.req.text()));
  });

  // ---------- Twilio inbound SMS
  app.post("/webhooks/twilio/sms", async (c) => {
    const form = await c.req.parseBody();
    const params = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, String(v)]));
    if (!deps.allowUnsignedWebhooks) {
      const url = `${(deps.publicUrl ?? "").replace(/\/$/, "")}/webhooks/twilio/sms`;
      if (!deps.twilioAuthToken || !validTwilioSignature(deps.twilioAuthToken, url, params, c.req.header("x-twilio-signature"))) {
        return c.text("invalid signature", 403);
      }
    }
    if (!params.From || !params.To || params.Body === undefined || !params.MessageSid) return c.text("missing fields", 400);
    try {
      await handleInbound(db, { messenger: deps.messenger, classifier, now }, {
        from: params.From,
        to: params.To,
        body: params.Body,
        providerId: params.MessageSid,
      });
    } catch (err) {
      // A 500 makes Twilio retry; the MessageSid dedupe makes that safe.
      console.error("inbound sms failed", err);
      return c.text("error", 500);
    }
    return c.body("<Response></Response>", 200, { "Content-Type": "text/xml" });
  });

  // ---------- Guest check-in opt-in (public, rate limited)
  const attempts = new Map<string, number[]>();
  const limited = (key: string) => {
    const t = Date.now();
    const recent = (attempts.get(key) ?? []).filter((x) => t - x < 3_600_000);
    recent.push(t);
    attempts.set(key, recent);
    return recent.length > 10;
  };

  app.get("/checkin/:propertyId", async (c) => {
    const p = await getProperty(db, c.req.param("propertyId")).catch(() => null);
    return p ? c.html(checkinForm(p)) : c.notFound();
  });

  app.post("/checkin/:propertyId", async (c) => {
    const p = await getProperty(db, c.req.param("propertyId")).catch(() => null);
    if (!p) return c.notFound();
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    if (limited(`${p.id}:${ip}`)) return c.html(checkinForm(p, "Too many attempts. Please ask the front desk."), 429);
    const form = await c.req.parseBody();
    const values = { last_name: String(form.last_name ?? ""), room: String(form.room ?? ""), phone: String(form.phone ?? "") };
    const res = await recordConsent(db, deps.messenger, {
      propertyId: p.id,
      lastName: values.last_name,
      room: values.room,
      phone: values.phone,
      agreed: form.agree === "1",
    }, now());
    if (res.status === "invalid") return c.html(checkinForm(p, res.reason, values), 400);
    return c.html(checkinDone(p, res.status === "linked"));
  });

  // ---------- Staff UI (basic auth; the username is recorded on approvals and issues)
  app.use("/*", async (c, next) => {
    if (!deps.adminPassword) {
      c.set("user", deps.adminUser ?? "admin");
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
      `select 'requests_7d' as k, count(*)::text as n from review_requests where sent_at > $1::timestamptz - interval '7 days'
       union all select 'posted_7d', count(*)::text from reply_drafts where posted_at > $1::timestamptz - interval '7 days'
       union all select 'open_cases', count(*)::text from recovery_cases where resolved_at is null`,
      [now().toISOString()],
    );
    const stat = Object.fromEntries(stats.map((s) => [s.k, s.n]));
    return c.html(
      layout(
        "Review replies",
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

  app.get("/issues", async (c) => c.html(await issuesPage(db, now())));

  app.post("/issues", async (c) => {
    const form = await c.req.parseBody();
    const summary = String(form.summary ?? "").trim();
    if (!summary) return c.text("summary required", 400);
    // Logged by staff, so it's already being handled.
    await db.query(
      `insert into recovery_cases (stay_id, summary, source, opened_at, acknowledged_at, acknowledged_by)
       values ($1, $2, 'staff', $3, $3, $4)`,
      [String(form.stay), summary, now().toISOString(), c.get("user")],
    );
    return c.redirect("/issues");
  });

  app.post("/issues/:id/ack", async (c) => {
    await acknowledgeCase(db, c.req.param("id"), c.get("user"), now());
    return c.redirect("/issues");
  });

  app.post("/issues/:id/reply", async (c) => {
    const form = await c.req.parseBody();
    try {
      await replyToGuest(db, deps.messenger, c.req.param("id"), String(form.text ?? ""), c.get("user"), now());
    } catch (err) {
      return c.html(layout("Not sent", html`<p class="err">${(err as Error).message}</p><a href="/issues">Back</a>`), 400);
    }
    return c.redirect("/issues");
  });

  app.post("/issues/:id/resolve", async (c) => {
    const form = await c.req.parseBody();
    await resolveCase(db, c.req.param("id"), String(form.resolution ?? "").trim() || null, c.get("user"), now());
    return c.redirect("/issues");
  });

  app.get("/metrics", async (c) => c.html(await metricsPage(db, now())));

  app.get("/setup", async (c) => {
    const props = await listProperties(db);
    const base = (deps.publicUrl ?? new URL(c.req.url).origin).replace(/\/$/, "");
    const signs = await Promise.all(props.map((p) => qrSign(p, `${base}/checkin/${p.id}`)));
    return c.html(
      layout(
        "Check-in QR signs",
        html`<p class="noprint muted">Print one for each front desk. Guests scan it at check-in to get texts during their stay.</p>
          ${signs}`,
      ),
    );
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
          ${r.consentsLinked ? html`<p>Linked ${r.consentsLinked} check-in text sign-ups to guests.</p>` : ""}
          ${r.rowErrors.length
            ? html`<table>
                <tr><th>Row</th><th>Problem</th></tr>
                ${r.rowErrors.map((e) => html`<tr><td>${e.row}</td><td>${e.message}</td></tr>`)}
              </table>`
            : ""}
          <p><a href="/upload">Upload another</a> · <a href="/issues">Guest issues</a></p>
        `,
      ),
    );
  });

  return app;
}

/** One scheduler pass: apply events, send due messages, escalations and follow-ups, sync reviews. */
export async function tick(deps: AppDeps) {
  const now = deps.now?.() ?? new Date();
  const events = await processEvents(deps.db);
  const jobs = await runDueJobs(deps.db, { messenger: deps.messenger, now: () => now });
  const cases = await runCaseTimers(deps.db, deps.messenger, now);
  const reviews: Record<string, unknown> = {};
  for (const p of await listProperties(deps.db)) {
    if (!deps.source.supports(p)) continue;
    try {
      reviews[p.id] = await syncReviews(deps.db, p.id, deps);
    } catch (err) {
      reviews[p.id] = { error: (err as Error).message };
    }
  }
  return { events, jobs, cases, reviews };
}

export async function ingest(deps: AppDeps, propertyId: string, kind: ReportKind, csv: string) {
  const property = await getProperty(deps.db, propertyId);
  const now = deps.now?.() ?? new Date();
  const parsed = parseAsiReport(csv, { kind, timezone: property.timezone, mapping: parseMapping(property.report_mapping) });
  const result = await reconcile(deps.db, property.id, parsed.reservations, now);
  await processEvents(deps.db);
  const consentsLinked = await linkPendingConsents(deps.db, deps.messenger, property.id, now);
  return { ...result, rows: parsed.reservations.length, rowErrors: parsed.errors, consentsLinked };
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
