import { caseHistory, conversationHistory, unmatchedMessages } from "./inbox.js";
import { recordDelivery } from "./delivery.js";
import { pilotFunnel } from "./operations.js";
import { dispatchOutbox } from "./outbox.js";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { html } from "hono/html";
import { approveConsent, linkPendingConsents, recordConsent } from "./consent.js";
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
import { landingPage } from "./web/landing.js";
import { icon, layout, stars, statBox, type Flash } from "./web/layout.js";
import { loginPage } from "./web/login.js";
import { metricsPage } from "./web/metrics.js";
import { operationsPage, problemCounts, reportFreshness } from "./web/operations.js";
import { answer, topicFor, type Topic } from "./web/ask.js";
import { checkinDone, checkinForm, qrSign } from "./web/public.js";
import { rateLimited, sameOrigin } from "./security.js";
import { runRetentionIfDue } from "./retention.js";

export interface AppDeps {
  db: Db;
  messenger: Messenger;
  source: ReviewSource;
  drafter: ReplyDrafter;
  classifier?: Classifier;
  now?: () => Date;
  adminUser?: string;
  adminPassword?: string;
  production?: boolean;
  cronSecret?: string;
  /** Twilio auth token, for verifying inbound webhooks. */
  twilioAuthToken?: string;
  /** Public base URL (https://...), needed for webhook verification and links in alerts. */
  publicUrl?: string;
  /** Development only: accept unsigned Twilio webhooks. */
  allowUnsignedWebhooks?: boolean;
  /** Download links for the desktop apps and Chrome extension, shown on /welcome. */
  downloads?: Downloads;
}

export interface Downloads {
  mac?: string;
  windows?: string;
  chrome?: string;
}

type Env = { Variables: { user: string } };

export function createApp(deps: AppDeps) {
  const { db } = deps;
  if ((deps.production || process.env.NODE_ENV === "production" || process.env.MESSAGING_MODE === "live") && !deps.adminPassword) {
    throw new Error("ADMIN_PASSWORD is required in production/live mode");
  }
  if ((deps.production || process.env.NODE_ENV === "production" || process.env.MESSAGING_MODE === "live") && deps.allowUnsignedWebhooks) {
    throw new Error("Unsigned Twilio webhooks are forbidden in production/live mode");
  }
  const app = new Hono<Env>();
  const now = () => deps.now?.() ?? new Date();
  const classifier = deps.classifier ?? classifierFromEnv();
  const adminUser = deps.adminUser ?? "admin";
  const sessionKey = `reviewloop-session:${adminUser}:${deps.adminPassword ?? ""}`;
  const SESSION = "rl_session";
  const SESSION_HOURS = 12;
  const csrfToken = (session: string) => createHmac("sha256", sessionKey).update(`csrf:${session}`).digest("hex");

  // Forms rendered for a signed session carry a token bound to that session. Basic-auth API
  // clients remain usable without a token; browser Basic requests still need a same-origin header.
  app.use("/*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const publicPost = path === "/login" || path.startsWith("/checkin/");
    const exempt = path.startsWith("/webhooks/twilio/") || path.startsWith("/api/ingest/");
    const session = deps.adminPassword ? await getSignedCookie(c, sessionKey, SESSION) : undefined;
    if (c.req.method === "POST" && !exempt && deps.adminPassword) {
      const origin = c.req.header("origin"), referer = c.req.header("referer");
      const browser = !!origin || !!referer || !!session || publicPost;
      if (browser && !sameOrigin(c.req.url, origin, referer, deps.publicUrl)) return c.text("invalid origin", 403);
      if (session && !publicPost) {
        const body = await c.req.parseBody();
        if (body._csrf !== csrfToken(session)) return c.text("invalid CSRF token", 403);
      }
    }
    await next();
    if (session && c.res.headers.get("content-type")?.includes("text/html")) {
      const body = await c.res.text();
      const token = csrfToken(session);
      c.res = new Response(body.replace(/<form\b([^>]*\bmethod="post"[^>]*)>/gi,
        (_full, attrs: string) => `<form${attrs}><input type="hidden" name="_csrf" value="${token}">`),
      { status: c.res.status, headers: c.res.headers });
    }
  });

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

  app.post("/webhooks/twilio/status", async (c) => {
    const form = await c.req.parseBody();
    const params = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, String(v)]));
    const url = `${(deps.publicUrl ?? "").replace(/\/$/, "")}/webhooks/twilio/status`;
    if (!deps.twilioAuthToken || !validTwilioSignature(deps.twilioAuthToken, url, params, c.req.header("x-twilio-signature"))) {
      return c.text("invalid signature", 403);
    }
    if (!await recordDelivery(db, params.MessageSid ?? "", params.MessageStatus ?? "", params.ErrorCode, now())) return c.text("invalid status", 400);
    return c.body(null, 204);
  });

  // ---------- Guest check-in opt-in (public, rate limited)

  app.get("/checkin/:propertyId", async (c) => {
    const p = await getProperty(db, c.req.param("propertyId")).catch(() => null);
    return p ? c.html(checkinForm(p)) : c.notFound();
  });

  app.post("/checkin/:propertyId", async (c) => {
    const p = await getProperty(db, c.req.param("propertyId")).catch(() => null);
    if (!p) return c.notFound();
    const form = await c.req.parseBody();
    const values = { last_name: String(form.last_name ?? ""), room: String(form.room ?? ""), phone: String(form.phone ?? "") };
    if (await rateLimited(db, "checkin", `${p.id}:${values.last_name.toLowerCase()}:${values.room.toLowerCase()}`, 10, now()))
      return c.html(checkinForm(p, "Too many attempts. Please ask the front desk."), 429);
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

  // ---------- Public product page
  app.get("/welcome", (c) => c.html(landingPage({ downloads: deps.downloads ?? {} })));

  // ---------- Staff sign-in. A signed session cookie for browsers, the installed web app and the
  // desktop app; HTTP basic auth still works for scripts. The username is recorded on approvals and issues.
  const same = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
  const validLogin = (user: string, password: string) => same(user, adminUser) && same(password, deps.adminPassword ?? "");
  const safeNext = (next: unknown) => {
    if (typeof next !== "string" || !next.startsWith("/") || /[\\\u0000-\u001f]/.test(next)) return "/issues";
    try {
      return new URL(next, "https://reviewloop.invalid").origin === "https://reviewloop.invalid" ? next : "/issues";
    } catch { return "/issues"; }
  };

  app.get("/login", (c) => (deps.adminPassword ? c.html(loginPage({ next: safeNext(c.req.query("next")) })) : c.redirect("/issues")));

  app.post("/login", async (c) => {
    const form = await c.req.parseBody();
    const next = safeNext(form.next);
    const user = String(form.user ?? "").trim();
    if (await rateLimited(db, "login", user.toLowerCase(), 10, now()))
      return c.html(loginPage({ next, user, error: "Too many attempts. Try again later." }), 429);
    if (!deps.adminPassword || !validLogin(user, String(form.password ?? ""))) {
      return c.html(loginPage({ next, user, error: "That username and password don't match." }), 401);
    }
    await setSignedCookie(c, SESSION, `${user}|${Date.now() + SESSION_HOURS * 3_600_000}`, sessionKey, {
      httpOnly: true,
      sameSite: "Lax",
      secure: new URL(deps.publicUrl ?? c.req.url).protocol === "https:",
      path: "/",
      maxAge: SESSION_HOURS * 3_600,
    });
    return c.redirect(next);
  });

  app.post("/logout", (c) => {
    deleteCookie(c, SESSION, { path: "/" });
    return c.redirect(deps.adminPassword ? "/login" : "/welcome");
  });

  app.use("/*", async (c, next) => {
    if (!deps.adminPassword) {
      c.set("user", adminUser);
      return next();
    }
    const session = await getSignedCookie(c, sessionKey, SESSION);
    if (session) {
      const [user, expires] = session.split("|");
      if (user && Number(expires) > Date.now()) {
        c.set("user", user);
        return next();
      }
    }
    const basic = c.req.header("authorization")?.match(/^Basic (.+)$/i)?.[1];
    if (basic) {
      const [user = "", ...rest] = Buffer.from(basic, "base64").toString().split(":");
      if (validLogin(user, rest.join(":"))) {
        c.set("user", user);
        return next();
      }
    }
    if (c.req.method === "GET" && c.req.header("accept")?.includes("text/html")) {
      const url = new URL(c.req.url);
      // Visitors arriving at the bare domain see the product page; staff links go to sign-in.
      if (url.pathname === "/" && !url.search) return c.redirect("/welcome");
      return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
    }
    return c.json({ error: "unauthorized" }, 401);
  });

  // Counts for the sidebar, the app badge and desktop notifications.
  app.get("/api/status", async (c) => {
    const [counts] = await db.query<{ unacked: number; open: number; urgent: number; awaiting: number }>(
      `select (select count(*)::int from recovery_cases where resolved_at is null and acknowledged_at is null) as unacked,
              (select count(*)::int from recovery_cases where resolved_at is null) as open,
              (select count(*)::int from recovery_cases where resolved_at is null and urgency = 'urgent') as urgent,
              (select count(*)::int from reply_drafts where status in ('pending', 'failed')) as awaiting,
              (select count(*)::int from consents where approved_at is null and created_at > now() - interval '2 days') as signups,
              (select max(created_at)::text from messages where kind <> 'alert') as "lastActivity"`,
    );
    const [latest] = await db.query<{ summary: string; urgency: string; property: string }>(
      `select c.summary, c.urgency, p.name as property from recovery_cases c join stays s on s.id = c.stay_id
         join properties p on p.id = s.property_id
        where c.resolved_at is null and c.acknowledged_at is null order by c.opened_at desc limit 1`,
    );
    const problems = (await problemCounts(db, now())).total;
    return c.json({
      ...counts,
      problems,
      latest: latest ? `${latest.property}: ${latest.summary}` : null,
      latestUrgent: latest?.urgency === "urgent",
    });
  });

  app.get("/api/cases", async (c) => {
    const before = c.req.query("before");
    if (before && !/^\d+$/.test(before)) return c.json({ error: "invalid cursor" }, 400);
    return c.json(await caseHistory(db, before));
  });
  app.get("/api/conversations/:stayId", async (c) => {
    const id = c.req.param("stayId"), before = c.req.query("before");
    if (!/^\d+$/.test(id) || (before && !/^\d+$/.test(before))) return c.json({ error: "invalid id or cursor" }, 400);
    return c.json(await conversationHistory(db, id, before));
  });
  app.get("/api/messages/unmatched", async (c) => {
    const before = c.req.query("before");
    if (before && !/^\d+$/.test(before)) return c.json({ error: "invalid cursor" }, 400);
    return c.json(await unmatchedMessages(db, before));
  });

  // Backend-only operational tools. They use the same staff authentication as the app.
  app.get("/api/consents/pending", async (c) => c.json(await db.query(
    "select id::text, property_id, phone, last_name, room, created_at from consents where approved_at is null and created_at > $1::timestamptz - interval '2 days' order by created_at", [now().toISOString()],
  )));
  app.post("/api/consents/:id/approve", async (c) => {
    const form = await c.req.parseBody();
    if (form.verified !== "1") return c.json({ error: "Verify the guest identity and control of the phone in person, then submit verified=1" }, 400);
    const result = await approveConsent(db, deps.messenger, c.req.param("id"), c.get("user"), now());
    return c.json(result, result.status === "invalid" ? 400 : 200);
  });
  app.get("/api/metrics/:propertyId", async (c) => {
    const end = now();
    const start = new Date(c.req.query("since") ?? new Date(end.getTime() - 28 * 86400000).toISOString());
    if (!Number.isFinite(start.getTime()) || start >= end) return c.json({ error: "since must be a valid past date" }, 400);
    const metrics = await pilotFunnel(db, c.req.param("propertyId"), start, end);
    return metrics ? c.json({ since: start, until: end, ...metrics }) : c.notFound();
  });
  app.get("/api/operations", async (c) => c.json({
    deliveryFailures: await db.query("select r.provider_id, r.status, r.error_code, r.updated_at, m.id::text as message_id from sms_delivery_receipts r left join messages m on m.provider_id = r.provider_id where r.status in ('failed', 'undelivered')"),
    outbound: await db.query("select id::text, status, attempts, next_attempt_at, last_error from outbound_queue where status <> 'sent' order by id"),
    followups: await db.query("select id::text, followup_error, followup_due_at from recovery_cases where followup_error is not null"),
    escalations: await db.query("select id::text, escalation_error, escalation_next_attempt_at from recovery_cases where escalation_error is not null"),
    jobs: await db.query("select id::text, kind, status, result, updated_at from jobs where status in ('failed', 'running')"),
    sync: await db.query("select * from sync_state order by key"),
  }));

  // Review replies. After a failed post the page comes back with what they wrote and why.
  const repliesPage = async (c: Context<Env>, failed?: { id: string; text: string; error: string }) => {
    const queue = await db.query<QueueRow>(
      `select d.id::text, d.draft, d.status, d.error, r.author, r.rating, r.body, r.reviewed_at, r.source,
              p.name as property, case when r.stay_verified_at is not null then s.confirmation end as confirmation
         from reply_drafts d join reviews r on r.id = d.review_id join properties p on p.id = r.property_id
         left join stays s on s.id = r.stay_id
        where d.status in ('pending', 'failed')
        -- Failed posts first, then the lowest ratings: those are the replies future guests read most.
        order by (d.status = 'failed') desc, coalesce(r.rating, 0), r.reviewed_at`,
    );
    const stats = await db.query<{ k: string; n: string }>(
      `select 'requests_7d' as k, count(*)::text as n from review_requests where sent_at > $1::timestamptz - interval '7 days'
       union all select 'posted_7d', count(*)::text from reply_drafts where posted_at > $1::timestamptz - interval '7 days'`,
      [now().toISOString()],
    );
    const stat = Object.fromEntries(stats.map((s) => [s.k, s.n]));
    return c.html(
      layout(
        "Review replies",
        html`
          <div class="stats">
            ${statBox("Awaiting you", String(queue.length))} ${statBox("Requests sent, 7 days", stat.requests_7d ?? "0")}
            ${statBox("Replies posted, 7 days", stat.posted_7d ?? "0")}
          </div>
          ${queue.length === 0 ? html`<p class="empty">Nothing to approve. New reviews show up here after the next sync.</p>` : html`<h2>Waiting for you</h2>`}
          ${queue.map(
            (q) => html`
              <article class="card ${q.status}">
                <header>
                  ${stars(q.rating)} <strong>${q.author ?? "Anonymous"}</strong> · ${q.property} ·
                  ${new Date(q.reviewed_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  ${q.confirmation ? html`<span class="tag" title="Staff confirmed which stay this review is from">Stay ${q.confirmation}</span>` : ""}
                  ${q.status === "failed" ? html`<span class="tag err">Post failed: ${q.error}</span>` : ""}
                </header>
                <blockquote>${q.body ?? "(rating only)"}</blockquote>
                <form method="post" action="/drafts/${q.id}/approve">
                  ${failed?.id === q.id ? html`<p class="err small" role="alert">${failed.error}</p>` : ""}
                  <label>Reply draft <span class="muted small">· edit anything before posting</span><textarea name="text" rows="5" required>${failed?.id === q.id ? failed.text : q.draft}</textarea></label>
                  <div class="actions">
                    <button type="submit" data-busy-text="Posting…">${q.status === "failed" ? "Try posting again" : "Approve and post"}</button>
                    <button type="submit" class="secondary" formaction="/drafts/${q.id}/dismiss" formnovalidate>Dismiss</button>
                  </div>
                </form>
              </article>
            `,
          )}
        `,
        {
          active: "/",
          flash: failed && !queue.some((q) => q.id === failed.id)
            ? { text: failed.error, tone: "err" }
            : c.req.query("undo") ? undefined : flashFrom(c.req.query("ok")),
          undo: c.req.query("undo") ? { text: "Draft dismissed. Nothing was posted.", action: `/drafts/${encodeURIComponent(c.req.query("undo")!)}/restore` } : undefined,
          lede: "Claude drafts a reply to every new review. Replies wait here for approval, unless a hotel is set to post 4 and 5 stars on its own. Sensitive topics always wait.",
        },
      ),
      failed ? 400 : 200,
    );
  };
  app.get("/", (c) => repliesPage(c));

  app.post("/drafts/:id/approve", async (c) => {
    const form = await c.req.parseBody();
    const id = c.req.param("id");
    const text = String(form.text ?? "");
    const res = await approveDraft(db, deps.source, id, text, c.get("user")).catch((err: Error) => ({ ok: false as const, error: err.message }));
    if (!res.ok) {
      const error =
        res.error === "reply text is empty" ? "Write a reply before posting."
        : res.error === "draft is not awaiting approval" ? "This reply was already posted or dismissed, maybe from another screen."
        : `Not posted: ${res.error}. Your text is still here; try again.`;
      return repliesPage(c, { id, text, error });
    }
    return c.redirect("/?ok=posted");
  });

  app.post("/drafts/:id/dismiss", async (c) => {
    await dismissDraft(db, c.req.param("id"), c.get("user"));
    return c.redirect(`/?ok=dismissed&undo=${encodeURIComponent(c.req.param("id"))}`);
  });

  // Undo a dismissal for a few minutes afterwards. Nothing was posted, so it's safe to bring back.
  app.post("/drafts/:id/restore", async (c) => {
    await db.query(
      `update reply_drafts set status = 'pending', decided_by = null, decided_at = null
        where id = $1 and status = 'dismissed' and decided_at > now() - interval '10 minutes'`,
      [c.req.param("id")],
    );
    return c.redirect("/?ok=restored");
  });

  app.get("/issues", async (c) =>
    c.html(
      await issuesPage(db, now(), {
        selected: c.req.query("id"),
        flash: flashFrom(c.req.query("ok")),
        tab: c.req.query("tab"),
        view: c.req.query("view"),
        hotel: c.req.query("hotel"),
        q: c.req.query("q"),
        sort: c.req.query("sort"),
      }),
    ),
  );

  // Ask Reviewloop: answers computed from live data (see web/ask.ts).
  app.get("/api/ask", async (c) => {
    const t = c.req.query("topic");
    const topic: Topic | null = t === "complaints" || t === "risk" || t === "reviews" ? t : topicFor(c.req.query("q") ?? "");
    return c.json(await answer(db, now(), topic));
  });

  app.post("/issues", async (c) => {
    const form = await c.req.parseBody();
    const summary = String(form.summary ?? "").trim();
    if (!summary) return c.text("summary required", 400);
    // Logged by staff, so it's already being handled.
    if (!form.stay) return c.text("guest required", 400);
    const [created] = await db.query<{ id: string }>(
      `insert into recovery_cases (stay_id, summary, source, opened_at, acknowledged_at, acknowledged_by)
       values ($1, $2, 'staff', $3, $3, $4) returning id::text`,
      [String(form.stay), summary, now().toISOString(), c.get("user")],
    );
    return c.redirect(`/issues?id=${created!.id}&ok=logged`);
  });

  app.post("/issues/:id/ack", async (c) => {
    await acknowledgeCase(db, c.req.param("id"), c.get("user"), now());
    return c.redirect(`/issues?id=${c.req.param("id")}&ok=ack`);
  });

  // Check-in QR sign-ups: someone at the desk confirms the guest and phone in person.
  app.post("/consents/:id/approve", async (c) => {
    const form = await c.req.parseBody();
    if (form.verified !== "1") {
      return c.html(await issuesPage(db, now(), { flash: { text: "Tick “Checked in person” first.", tone: "err" } }), 400);
    }
    const res = await approveConsent(db, deps.messenger, c.req.param("id"), c.get("user"), now());
    if (res.status === "invalid") return c.html(await issuesPage(db, now(), { flash: { text: res.reason, tone: "err" } }), 400);
    return c.redirect("/issues?ok=connected");
  });

  app.post("/issues/:id/reply", async (c) => {
    const form = await c.req.parseBody();
    const id = c.req.param("id");
    const text = String(form.text ?? "");
    try {
      await replyToGuest(db, deps.messenger, id, text, c.get("user"), now());
    } catch (err) {
      // Stay on the conversation and keep what they typed.
      return c.html(await issuesPage(db, now(), { selected: id, draft: { caseId: id, text, error: `Not sent: ${(err as Error).message}` } }), 400);
    }
    return c.redirect(`/issues?id=${id}&ok=sent`);
  });

  app.post("/issues/:id/resolve", async (c) => {
    const form = await c.req.parseBody();
    await resolveCase(db, c.req.param("id"), String(form.resolution ?? "").trim() || null, c.get("user"), now());
    return c.redirect("/issues?ok=resolved");
  });

  app.get("/metrics", async (c) => c.html(await metricsPage(db, now())));

  app.get("/operations", async (c) => c.html(await operationsPage(db, now())));

  app.get("/setup", async (c) => {
    const props = await listProperties(db);
    const base = (deps.publicUrl ?? new URL(c.req.url).origin).replace(/\/$/, "");
    const signs = await Promise.all(props.map((p) => qrSign(p, `${base}/checkin/${p.id}`)));
    return c.html(
      layout(
        "Check-in QR signs",
        html`${signs}`,
        {
          active: "/setup",
          lede: "Print one for each front desk. Guests scan it, then the desk confirms them on Guest issues before their first text.",
          head: html`<script>
            window.addEventListener("afterprint", function () {
              delete document.body.dataset.print;
              document.querySelectorAll(".print-me").forEach(function (el) { el.classList.remove("print-me"); });
            });
          </script>`,
        },
      ),
    );
  });

  app.get("/upload", async (c) => {
    const props = await listProperties(db);
    const fresh = await reportFreshness(db, now());
    return c.html(
      layout(
        "Upload ASI report",
        html`
          <div class="fresh-list">
            ${fresh.map(
              (f) => html`<div class="fresh-row">
                <strong>${f.name}</strong>
                ${f.reports.map(
                  (r) => html`<span class="fresh-item">${r.kind === "in_house" ? "In-house" : "Departures"}
                    ${r.at
                      ? r.today
                        ? html`<span class="tag good">Today</span>`
                        : html`<span class="tag err">Not today</span>`
                      : html`<span class="tag">Never</span>`}</span>`,
                )}
              </div>`,
            )}
          </div>
          <form method="post" action="/upload" enctype="multipart/form-data" class="card form-card">
            <label>Hotel <select name="property" required>
              ${props.length > 1 ? html`<option value="" selected disabled>Choose a hotel</option>` : ""}
              ${props.map((p) => html`<option value="${p.id}">${p.name}</option>`)}
            </select></label>
            <fieldset class="kinds">
              <legend>Which report is it?</legend>
              ${REPORT_ORDER.map(
                (k, i) => html`<label class="kind"><input type="radio" name="kind" value="${k}" ${i === 0 ? "checked" : ""} required />
                  <span><strong>${REPORT_LABEL[k].name}</strong><small>${REPORT_LABEL[k].hint}</small></span></label>`,
              )}
            </fieldset>
            <label class="drop">
              <input type="file" name="file" accept=".csv,text/csv" required onchange="this.closest('.drop').dataset.file = this.files[0] ? this.files[0].name : ''" />
              <span class="drop-cta">${icon("upload")} Choose the CSV file</span>
              <span class="drop-name muted small">Exported from ASI. Uploading the same file twice is safe.</span>
            </label>
            <button type="submit" class="wide" data-busy-text="Importing…">Import report</button>
          </form>
        `,
        { active: "/upload", lede: "Upload today’s in-house and departures reports each morning. Welcome texts and review requests are timed from them." },
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
          ${r.rows === 0 && !r.rowErrors.length
            ? html`<p class="banner warn" role="alert">${icon("alert")}<strong>No guests found in this file.</strong>
                <span>If this report should list guests, check it’s the ${REPORT_LABEL[kind].name} report exported from ASI as CSV, then upload it again.</span></p>`
            : ""}
          ${r.consentsLinked ? html`<p>Linked ${r.consentsLinked} check-in text sign-ups to guests.</p>` : ""}
          ${r.rowErrors.length
            ? html`<h2>Rows with problems</h2>
                <div class="table-wrap"><table>
                  <tr><th>Row</th><th>Problem</th></tr>
                  ${r.rowErrors.map((e) => html`<tr><td>${e.row}</td><td>${e.message}</td></tr>`)}
                </table></div>`
            : ""}
          <div class="actions"><a class="btn" href="/upload">Upload another</a><a class="btn secondary" href="/issues">Guest issues</a></div>
        `,
        { active: "/upload" },
      ),
    );
  });

  return app;
}

/** One scheduler pass: apply events, send due messages, escalations and follow-ups, sync reviews. */
export async function tick(deps: AppDeps) {
  const now = deps.now?.() ?? new Date();
  await runRetentionIfDue(deps.db, now, Number(process.env.PII_RETENTION_DAYS ?? 365));
  const outbound = await dispatchOutbox(deps.db, deps.messenger, now);
  const events = await processEvents(deps.db);
  const jobs = await runDueJobs(deps.db, { messenger: deps.messenger, now: () => now });
  const cases = await runCaseTimers(deps.db, deps.messenger, now);
  const reviews: Record<string, unknown> = {};
  for (const p of await listProperties(deps.db)) {
    if (!deps.source.supports(p)) continue;
    try {
      const result = await syncReviews(deps.db, p.id, deps);
      reviews[p.id] = result;
      await deps.db.query(`insert into sync_state (key, value, updated_at) values ($1, $2, $3)
        on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
        [`reviews:${p.id}`, JSON.stringify({ lastAttempt: now, ok: result.errors.length === 0, errors: result.errors }), now.toISOString()]);
    } catch (err) {
      reviews[p.id] = { error: (err as Error).message };
      await deps.db.query(`insert into sync_state (key, value, updated_at) values ($1, $2, $3)
        on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
        [`reviews:${p.id}`, JSON.stringify({ lastAttempt: now, ok: false, error: (err as Error).message }), now.toISOString()]);
    }
  }
  return { events, jobs, cases, reviews, outbound };
}

export async function ingest(deps: AppDeps, propertyId: string, kind: ReportKind, csv: string) {
  const property = await getProperty(deps.db, propertyId);
  const now = deps.now?.() ?? new Date();
  const parsed = parseAsiReport(csv, { kind, timezone: property.timezone, mapping: parseMapping(property.report_mapping) });
  const result = await reconcile(deps.db, property.id, parsed.reservations, now);
  await processEvents(deps.db);
  const consentsLinked = await linkPendingConsents(deps.db, deps.messenger, property.id, now);
  await deps.db.query(`insert into sync_state (key, value, updated_at) values ($1, $2, $3)
    on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    [`import:${property.id}:${kind}`, JSON.stringify({ rows: parsed.reservations.length, rowErrors: parsed.errors.length }), now.toISOString()]);
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

const FLASH: Record<string, Flash> = {
  ack: { text: "It’s yours. The GM won’t be texted about this one." },
  sent: { text: "Text sent." },
  resolved: { text: "Resolved. If they can get texts, we’ll ask the guest in 30 minutes whether it’s better." },
  logged: { text: "Issue logged and assigned to you." },
  connected: { text: "Connected. That guest can get texts from the desk now." },
  posted: { text: "Reply posted to Google." },
  dismissed: { text: "Draft dismissed. Nothing was posted." },
  restored: { text: "Draft is back in the queue." },
};
const flashFrom = (code: string | undefined) => (code ? FLASH[code] : undefined);

// The two daily reports first; In-house is the default.
const REPORT_ORDER: ReportKind[] = ["in_house", "departures", "arrivals", "reservations"];
const REPORT_LABEL: Record<ReportKind, { name: string; hint: string }> = {
  arrivals: { name: "Arrivals", hint: "Guests expected to check in" },
  in_house: { name: "In-house", hint: "Who’s staying tonight. Starts welcome and check-in texts" },
  departures: { name: "Departures", hint: "Today’s checkouts. Starts review requests" },
  reservations: { name: "Reservations", hint: "Upcoming bookings" },
};
