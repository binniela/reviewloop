import { caseHistory, conversationHistory, unmatchedMessages } from "./inbox.js";
import { recordDelivery } from "./delivery.js";
import { pilotFunnel } from "./operations.js";
import { dispatchOutbox } from "./outbox.js";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { alertStatus, schedulerAlert } from "./alerts.js";
import { log } from "./log.js";
import { acquireLease, lastTick, recordTick } from "./scheduler.js";
import { Hono, type Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { html } from "hono/html";
import { approveConsent, linkPendingConsents, recordConsent } from "./consent.js";
import { pendingMigrations, type Db } from "./db.js";
import { classifierFromEnv, type Classifier } from "./inbound/classify.js";
import { acknowledgeCase, replyToGuest, resolveCase, runCaseTimers } from "./inbound/cases.js";
import { handleInbound } from "./inbound/handle.js";
import { validTwilioSignature } from "./inbound/twilioSignature.js";
import { parseAsiReport, parseMapping, REPORT_KINDS, type ReportKind } from "./ingest/asiReport.js";
import { reconcile } from "./ingest/reconcile.js";
import type { Messenger } from "./messaging.js";
import { processEvents, runDueJobs } from "./milestones/engine.js";
import { getProperty, listProperties, pauseGuestTexts, resumeGuestTexts } from "./properties.js";
import type { ReplyDrafter } from "./reviews/drafter.js";
import type { ReviewSource } from "./reviews/sources.js";
import { approveDraft, dismissDraft, syncReviews } from "./reviews/sync.js";
import { issuesPage } from "./web/issues.js";
import { landingPage } from "./web/landing.js";
import { layout, stars, statBox, type Flash } from "./web/layout.js";
import { loginPage } from "./web/login.js";
import { metricsPage } from "./web/metrics.js";
import { alertHealth, operationsPage, problemCounts, reportFreshness, schedulerHealth } from "./web/operations.js";
import { answer, topicFor, type Topic } from "./web/ask.js";
import { checkinDone, checkinForm, qrSign } from "./web/public.js";
import { hotelForm, hotelsPage, saveHotelForm, type HotelForm } from "./web/hotels.js";
import { checkPage, importResultPage, mappingFromForm, uploadPage } from "./web/upload.js";
import { attemptsSoFar, clearLimit, rateLimited, sameOrigin } from "./security.js";
import {
  activeGmCount, audit, bootstrapStaff, checkName, checkPassword, checkPin, checkUsername, createStaff, endSession,
  findByUsername, getStaff, nameTaken, passwordHash, pinHash, pinStaff, readDevice, readSession, registerDevice, removeDevice,
  removeStaff, SESSION_HOURS, setRole, setSecrets, startSession, suggestUsername, touchSession, usernameTaken, verifySecret,
  bindSessionToDevice, listDevices,
} from "./staff.js";
import { runAs, type Role, type Viewer } from "./viewer.js";
import { accountPage, auditPage, staffPage, switchPage, type StaffForm } from "./web/staff.js";
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
  /** How long one scheduler tick may keep starting review drafts, in ms. */
  tickBudgetMs?: number;
  /** Download links for the desktop apps and Chrome extension, shown on /welcome. */
  downloads?: Downloads;
  /** Minutes without activity before a shared front-desk PC goes back to the name picker. */
  deskIdleMinutes?: number;
  monitorToken?: string;
  schedulerExpected?: boolean;
}

export interface Downloads {
  mac?: string;
  windows?: string;
  chrome?: string;
}

type Env = { Variables: { user: string; viewer: Viewer; token?: string } };

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
  const csrfToken = (session: string) => createHmac("sha256", sessionKey).update(`csrf:${session}`).digest("hex");

  // Forms rendered for a signed session carry a token bound to that session. Basic-auth API
  // clients remain usable without a token; browser Basic requests still need a same-origin header.
  app.use("/*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const publicPost = path === "/login" || path === "/switch" || path.startsWith("/checkin/");
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
    if (!deps.cronSecret || !bearerMatches(c.req.header("authorization"), deps.cronSecret)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };

  // A failed step answers 500 so Vercel's cron log shows the run as failed; details are on Operations.
  app.get("/cron/tick", requireSecret, async (c) => {
    const result = await tick(deps);
    if ("skipped" in result) return c.json(result, 200);
    return c.json(result, result.ok ? 200 : 500);
  });

  // For an uptime monitor: 503 when the database, scheduler or staff alert delivery needs attention.
  app.get("/healthz", async (c) => {
    try {
      const health = await schedulerHealth(db, now());
      const alertFailures = await alertHealth(db);
      return c.json({ db: "ok", scheduler: health.state, alerts: alertFailures ? "attention" : "ok", alertFailures },
        health.state === "ok" && !alertFailures ? 200 : 503);
    } catch {
      return c.json({ db: "error" }, 503);
    }
  });

  // ---------- Health. /health is public and cheap: for the uptime monitor and load balancers.
  // It says only whether the app can serve; /health/alerts says whether it's doing its job.
  const alertOptions = { scheduler: deps.schedulerExpected ?? !!deps.cronSecret };
  app.get("/health", async (c) => {
    const commit = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null;
    try {
      const pending = await pendingMigrations(db);
      const ok = pending.length === 0;
      return c.json({ ok, database: "ok", migrations: ok ? "current" : `${pending.length} pending`, commit }, ok ? 200 : 503);
    } catch (err) {
      log.error("health.db_failed", { error: err });
      return c.json({ ok: false, database: "unreachable", commit }, 503);
    }
  });
  app.get("/health/alerts", async (c) => {
    const tokens = [deps.monitorToken, deps.cronSecret].filter((t): t is string => !!t);
    if (!tokens.some((t) => bearerMatches(c.req.header("authorization"), t))) return c.json({ error: "unauthorized" }, 401);
    const status = await alertStatus(db, now(), alertOptions);
    if (!status.ok) log.warn("health.alerts", { codes: status.alerts.map((a) => a.code) });
    return c.json({ ...status, checkedAt: now().toISOString() }, status.ok ? 200 : 503);
  });

  app.post("/api/ingest/:propertyId", requireSecret, async (c) => {
    const kind = c.req.query("kind") as ReportKind;
    if (!REPORT_KINDS.includes(kind)) return c.json({ error: `kind must be one of ${REPORT_KINDS.join(", ")}` }, 400);
    return c.json(await ingest(deps, c.req.param("propertyId") ?? "", kind, await c.req.text()));
  });

  // Twilio signs the exact URL it was given, query string included. Behind Vercel deployment
  // protection that URL carries ?x-vercel-protection-bypass=..., so the query must be part of it.
  const signedUrl = (c: Context<Env>) => {
    const req = new URL(c.req.url);
    return `${(deps.publicUrl ?? "").replace(/\/$/, "")}${req.pathname}${req.search}`;
  };

  // ---------- Twilio inbound SMS
  app.post("/webhooks/twilio/sms", async (c) => {
    const form = await c.req.parseBody();
    const params = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, String(v)]));
    if (!deps.allowUnsignedWebhooks) {
      if (!deps.twilioAuthToken || !validTwilioSignature(deps.twilioAuthToken, signedUrl(c), params, c.req.header("x-twilio-signature"))) {
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
      // Provider errors may echo message content or phone numbers; keep raw details out of logs.
      console.error("inbound sms failed", err instanceof Error ? err.name : "unknown error");
      return c.text("error", 500);
    }
    return c.body("<Response></Response>", 200, { "Content-Type": "text/xml" });
  });

  app.post("/webhooks/twilio/status", async (c) => {
    const form = await c.req.parseBody();
    const params = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, String(v)]));
    if (!deps.twilioAuthToken || !validTwilioSignature(deps.twilioAuthToken, signedUrl(c), params, c.req.header("x-twilio-signature"))) {
      return c.text("invalid signature", 403);
    }
    if (!await recordDelivery(db, params.MessageSid ?? "", params.MessageStatus ?? "", params.ErrorCode, now(), c.req.query("rl_outbox"))) return c.text("invalid status", 400);
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
    if (await rateLimited(db, "checkin-property", p.id, 500, now()) ||
        await rateLimited(db, "checkin-phone", `${p.id}:${values.phone.replace(/\D/g, "")}`, 10, now()) ||
        await rateLimited(db, "checkin-guest", `${p.id}:${values.last_name.toLowerCase()}:${values.room.toLowerCase()}`, 10, now()))
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

  // ---------- Staff sign-in. Everyone has their own account (see staff.ts): a password anywhere, or
  // name plus 4-digit PIN on a registered front-desk PC. Sessions live in the database behind a
  // signed, HTTP-only cookie. HTTP Basic checks the same active per-person accounts.
  const safeNext = (next: unknown) => {
    if (typeof next !== "string" || !next.startsWith("/") || /[\\\u0000-\u001f]/.test(next)) return "/issues";
    try {
      return new URL(next, "https://reviewloop.invalid").origin === "https://reviewloop.invalid" ? next : "/issues";
    } catch { return "/issues"; }
  };
  const idleMinutes = deps.deskIdleMinutes ?? 15;
  const DEVICE = "rl_desk";
  const secure = (c: Context<Env>) => new URL(deps.publicUrl ?? c.req.url).protocol === "https:";
  const setSession = (c: Context<Env>, token: string) =>
    setSignedCookie(c, SESSION, token, sessionKey, { httpOnly: true, sameSite: "Lax", secure: secure(c), path: "/", maxAge: SESSION_HOURS * 3_600 });
  const deskDevice = async (c: Context<Env>) => (deps.adminPassword ? readDevice(db, await getSignedCookie(c, sessionKey, DEVICE)) : null);
  const wantsHtml = (c: Context<Env>) => c.req.method === "GET" && !!c.req.header("accept")?.includes("text/html");
  // The shared login becomes the first GM account the first time this database sees a request.
  let booted: Promise<void> | undefined;
  const ready = () => {
    if (!deps.adminPassword) return Promise.resolve();
    booted ??= bootstrapStaff(db, adminUser, deps.adminPassword, now()).catch((err) => { booted = undefined; throw err; });
    return booted;
  };

  app.get("/login", async (c) => {
    if (!deps.adminPassword) return c.redirect("/issues");
    const next = safeNext(c.req.query("next"));
    if (!c.req.query("password") && (await deskDevice(c))) return c.redirect(`/switch?next=${encodeURIComponent(next)}`);
    return c.html(loginPage({ next }));
  });

  app.post("/login", async (c) => {
    await ready();
    const form = await c.req.parseBody();
    const next = safeNext(form.next);
    const user = String(form.user ?? "").trim();
    const password = String(form.password ?? "");
    if (await rateLimited(db, "login", user.toLowerCase(), 10, now()))
      return c.html(loginPage({ next, user, error: "Too many attempts. Try again later." }), 429);
    const found = deps.adminPassword ? await findByUsername(db, user) : null;
    let staffId = found && (await verifySecret(password, found.password_hash)) ? found.id : null;
    if (!found) await verifySecret(password, null);
    if (!staffId) return c.html(loginPage({ next, user, error: "That username and password don't match." }), 401);
    const device = await deskDevice(c);
    await setSession(c, await startSession(db, staffId, device?.id ?? null, now()));
    const name = found?.id === staffId ? found.name : ((await getStaff(db, staffId))?.name ?? adminUser);
    await audit(db, { id: staffId, name, device }, "signin.password", now());
    return c.redirect(next);
  });

  // "Who's at the desk?": only on a front-desk PC a GM registered, so a PIN never works from elsewhere.
  app.get("/switch", async (c) => {
    if (!deps.adminPassword) return c.redirect("/issues");
    await ready();
    const next = safeNext(c.req.query("next"));
    const device = await deskDevice(c);
    if (!device) return c.redirect(`/login?next=${encodeURIComponent(next)}`);
    return c.html(switchPage({ device: device.label, people: await pinStaff(db), next, idle: c.req.query("idle") === "1" }));
  });

  app.post("/switch", async (c) => {
    await ready();
    const device = await deskDevice(c);
    if (!device) return c.redirect("/login");
    const form = await c.req.parseBody();
    const next = safeNext(form.next);
    const id = String(form.staff ?? "");
    const people = await pinStaff(db);
    const page = (error: string, status: 400 | 401 | 429) => c.html(switchPage({ device: device.label, people, next, selected: id, error }), status);
    const person = await pinHash(db, id);
    if (!person?.pin_hash) return page("Pick your name first.", 400);
    // Only wrong PINs count, so someone switching in twenty times a shift is never locked out.
    if ((await attemptsSoFar(db, "pin-staff", id, now())) >= 5 || (await attemptsSoFar(db, "pin-device", device.id, now())) >= 20)
      return page("Too many wrong PINs. Sign in with your password, or ask a GM to reset your PIN.", 429);
    if (!(await verifySecret(String(form.pin ?? ""), person.pin_hash))) {
      await rateLimited(db, "pin-staff", id, 5, now());
      await rateLimited(db, "pin-device", device.id, 20, now());
      return page("That PIN isn’t right. Try again.", 401);
    }
    await clearLimit(db, "pin-staff", id);
    const previous = await getSignedCookie(c, sessionKey, SESSION);
    if (previous) await endSession(db, previous);
    await setSession(c, await startSession(db, id, device.id, now()));
    await audit(db, { id, name: person.name, device }, "signin.pin", now());
    return c.redirect(next);
  });

  // On a desk PC this is "Switch person": the session ends and the name picker comes back.
  app.post("/logout", async (c) => {
    const token = deps.adminPassword ? await getSignedCookie(c, sessionKey, SESSION) : undefined;
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const idle = form.idle === "1";
    if (token) {
      const s = idle ? await readSession(db, token, now(), idleMinutes) : null;
      if (s) await audit(db, s.viewer, "signout.idle", now());
      await endSession(db, token);
    }
    deleteCookie(c, SESSION, { path: "/" });
    if (!deps.adminPassword) return c.redirect("/welcome");
    return c.redirect((await deskDevice(c)) ? (idle ? "/switch?idle=1" : "/switch") : "/login");
  });

  const withViewer = (c: Context<Env>, v: Viewer, next: () => Promise<void>) => {
    c.set("viewer", v);
    c.set("user", v.name);
    return runAs(v, next);
  };

  app.use("/*", async (c, next) => {
    if (!deps.adminPassword) return withViewer(c, { id: null, name: adminUser, role: "gm", device: null, idleMinutes }, next);
    await ready();
    const token = await getSignedCookie(c, sessionKey, SESSION);
    if (token) {
      const s = await readSession(db, token, now(), idleMinutes);
      if (s?.idle) {
        await audit(db, s.viewer, "signout.idle", now());
        deleteCookie(c, SESSION, { path: "/" });
        if (wantsHtml(c)) return c.redirect("/switch?idle=1");
        return c.json({ error: "signed out after inactivity" }, 401);
      }
      if (s) {
        // Writes count as activity; polling for new issues doesn't (see /api/activity).
        if (c.req.method === "POST") {
          await touchSession(db, token, s.viewer.id!, now());
          s.viewer.idleFor = 0;
        }
        c.set("token", token);
        return withViewer(c, s.viewer, next);
      }
    }
    const basic = c.req.header("authorization")?.match(/^Basic (.+)$/i)?.[1];
    if (basic) {
      const [user = "", ...rest] = Buffer.from(basic, "base64").toString().split(":");
      const key = user.toLowerCase();
      if ((await attemptsSoFar(db, "basic", key, now())) < 10) {
        const person = await findByUsername(db, user);
        if (await verifySecret(rest.join(":"), person?.password_hash)) {
          return withViewer(c, { id: person!.id, name: person!.name, role: person!.role, device: null, idleMinutes }, next);
        }
        await rateLimited(db, "basic", key, 10, now());
      }
    }
    if (wantsHtml(c)) {
      const url = new URL(c.req.url);
      const target = encodeURIComponent(url.pathname + url.search);
      if (await deskDevice(c)) return c.redirect(url.pathname === "/" && !url.search ? "/switch" : `/switch?next=${target}`);
      // Visitors arriving at the bare domain see the product page; staff links go to sign-in.
      if (url.pathname === "/" && !url.search) return c.redirect("/welcome");
      return c.redirect(`/login?next=${target}`);
    }
    return c.json({ error: "unauthorized" }, 401);
  });

  // Front desk staff: Guest issues, Upload and the QR sign. Everything else is for GMs, including
  // approving and posting review replies.
  const GM_ONLY = /^\/($|drafts\/|metrics|operations|hotels|staff|audit|api\/metrics\/|api\/operations)/;
  app.use("/*", async (c, next) => {
    if (c.get("viewer").role === "gm") return next();
    const path = new URL(c.req.url).pathname;
    if (!GM_ONLY.test(path)) return next();
    if (wantsHtml(c)) return c.redirect(path === "/" ? "/issues" : "/issues?ok=gm-only");
    return c.json({ error: "Only a GM can do this" }, 403);
  });

  // The desk PC page reports activity at most every 20 seconds. The header keeps other sites from
  // keeping a desk signed in with a plain link or image.
  app.get("/api/activity", async (c) => {
    const v = c.get("viewer"), token = c.get("token");
    if (!c.req.header("x-reviewloop-activity")) return c.text("missing header", 400);
    if (token && v.id) await touchSession(db, token, v.id, now());
    return c.body(null, 204);
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
    // A silent scheduler counts too: nothing else on the console would show it.
    const scheduler = alertOptions.scheduler ? await schedulerAlert(db, now()) : null;
    const problems = (await problemCounts(db, now())).total + (scheduler ? 1 : 0);
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
    if (result.status === "linked") await audit(db, c.get("viewer"), "consent.approve", now(), c.req.param("id"));
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
                  ${stars(q.rating)} <strong>${q.author ?? "Anonymous"}</strong>
                  <span class="meta">${q.property} · ${new Date(q.reviewed_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
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
    // approveDraft throws before recording an approval; a returned error means it was approved but Google refused it.
    const res = await approveDraft(db, deps.source, id, text, c.get("user"))
      .then((r) => ({ ...r, approved: true }))
      .catch((err: Error) => ({ ok: false as const, error: err.message, approved: false }));
    if (res.approved) await audit(db, c.get("viewer"), res.ok ? "draft.approve" : "draft.post_failed", now(), id);
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
    if (await dismissDraft(db, c.req.param("id"), c.get("user"))) await audit(db, c.get("viewer"), "draft.dismiss", now(), c.req.param("id"));
    return c.redirect(`/?ok=dismissed&undo=${encodeURIComponent(c.req.param("id"))}`);
  });

  // Undo a dismissal for a few minutes afterwards. Nothing was posted, so it's safe to bring back.
  app.post("/drafts/:id/restore", async (c) => {
    const restored = await db.query(
      `update reply_drafts set status = 'pending', decided_by = null, decided_at = null
        where id = $1 and status = 'dismissed' and decided_at > now() - interval '10 minutes' returning 1`,
      [c.req.param("id")],
    );
    if (restored.length) await audit(db, c.get("viewer"), "draft.restore", now(), c.req.param("id"));
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
    await audit(db, c.get("viewer"), "case.log", now(), created!.id);
    return c.redirect(`/issues?id=${created!.id}&ok=logged`);
  });

  app.post("/issues/:id/ack", async (c) => {
    if (await acknowledgeCase(db, c.req.param("id"), c.get("user"), now())) await audit(db, c.get("viewer"), "case.take", now(), c.req.param("id"));
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
    await audit(db, c.get("viewer"), "consent.approve", now(), c.req.param("id"));
    return c.redirect("/issues?ok=connected");
  });

  app.post("/issues/:id/reply", async (c) => {
    const form = await c.req.parseBody();
    const id = c.req.param("id");
    const text = String(form.text ?? "");
    try {
      const took = await replyToGuest(db, deps.messenger, id, text, c.get("user"), now());
      if (took) await audit(db, c.get("viewer"), "case.take", now(), id);
      await audit(db, c.get("viewer"), "case.text", now(), id);
    } catch (err) {
      // Stay on the conversation and keep what they typed.
      return c.html(await issuesPage(db, now(), { selected: id, draft: { caseId: id, text, error: sendError((err as Error).message) } }), 400);
    }
    return c.redirect(`/issues?id=${id}&ok=sent`);
  });

  app.post("/issues/:id/resolve", async (c) => {
    const form = await c.req.parseBody();
    if (await resolveCase(db, c.req.param("id"), String(form.resolution ?? "").trim() || null, c.get("user"), now()))
      await audit(db, c.get("viewer"), "case.resolve", now(), c.req.param("id"));
    // "Resolve and open next": back to the same list, with the next issue open.
    const next = String(form.next ?? "");
    if (next.startsWith("/issues?") && !next.includes("//")) return c.redirect(`${next}&ok=resolved`);
    return c.redirect("/issues?ok=resolved");
  });

  app.get("/metrics", async (c) => c.html(await metricsPage(db, now())));

  app.get("/operations", async (c) => {
    const { alerts } = await alertStatus(db, now(), alertOptions);
    return c.html(await operationsPage(db, now(), alerts, await lastTick(db)));
  });

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

  app.get("/upload", async (c) => c.html(uploadPage(await listProperties(db), await reportFreshness(db, now()))));

  // Step 1 of an upload: read the file and show how it maps, without importing anything.
  app.post("/upload/check", async (c) => {
    const form = await c.req.parseBody();
    const kind = String(form.kind) as ReportKind;
    const property = await getProperty(db, String(form.property ?? "")).catch(() => null);
    const back = async (error: string) => c.html(uploadPage(await listProperties(db), await reportFreshness(db, now()), error), 400);
    if (!property) return back("Choose a hotel.");
    if (!REPORT_KINDS.includes(kind)) return back("Choose which report it is.");
    const file = form.file;
    const csv = file instanceof File ? await file.text() : String(form.csv ?? "");
    const name = file instanceof File ? file.name : String(form.file_name ?? "");
    if (!csv.trim()) return back("Choose the CSV file exported from ASI.");
    try {
      const mapping = mappingFromForm(form, parseMapping(property.report_mapping));
      return c.html(checkPage(property, kind, csv, mapping, name));
    } catch {
      return back("We couldn’t read that file as a CSV. Export the report from ASI as CSV (not Excel or PDF) and try again.");
    }
  });

  // Step 2: import. Also accepts a file directly, for scripts and older forms.
  app.post("/upload", async (c) => {
    const form = await c.req.parseBody();
    const file = form.file;
    const kind = String(form.kind) as ReportKind;
    const csv = file instanceof File ? await file.text() : typeof form.csv === "string" ? form.csv : null;
    if (csv == null || !REPORT_KINDS.includes(kind)) return c.text("missing file or report type", 400);
    const property = await getProperty(db, String(form.property ?? "")).catch(() => null);
    if (!property) return c.text("unknown hotel", 400);
    // Columns chosen on the check screen are remembered for this hotel's next upload.
    const mapping = mappingFromForm(form, parseMapping(property.report_mapping));
    if (mapping) {
      parseMapping(mapping);
      await db.query("update properties set report_mapping = $2 where id = $1", [property.id, JSON.stringify(mapping)]);
    }
    const r = await ingest(deps, property.id, kind, csv);
    return c.html(importResultPage(r, kind));
  });

  // ---------- Hotel setup (GM)
  app.get("/hotels", async (c) => c.html(await hotelsPage(db, flashFrom(c.req.query("ok")))));
  app.get("/hotels/new", (c) => c.html(hotelForm(null)));
  app.get("/hotels/:id", async (c) => {
    const p = await getProperty(db, c.req.param("id")).catch(() => null);
    return p ? c.html(hotelForm(p, { flash: flashFrom(c.req.query("ok")) })) : c.notFound();
  });
  const saveHotel = async (c: Context<Env>, id: string | null) => {
    const existing = id ? await getProperty(db, id).catch(() => null) : null;
    if (id && !existing) return c.notFound();
    const values = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)])) as HotelForm;
    try {
      const saved = await saveHotelForm(db, existing, values);
      return c.redirect(id ? `/hotels/${saved.id}?ok=hotel_saved` : "/hotels?ok=hotel_added");
    } catch (err) {
      return c.html(hotelForm(existing, { values, error: (err as Error).message }), 400);
    }
  };
  // One click stops every guest text for a hotel; held texts go out once on resume.
  app.post("/hotels/:id/pause", async (c) => {
    const id = c.req.param("id");
    if (!(await getProperty(db, id).catch(() => null))) return c.notFound();
    if (await pauseGuestTexts(db, id, c.get("user"), now())) await audit(db, c.get("viewer"), "texts.pause", now(), null, id);
    return c.redirect("/hotels?ok=paused");
  });
  app.post("/hotels/:id/resume", async (c) => {
    const id = c.req.param("id");
    if (!(await getProperty(db, id).catch(() => null))) return c.notFound();
    if (await resumeGuestTexts(db, id)) await audit(db, c.get("viewer"), "texts.resume", now(), null, id);
    return c.redirect("/hotels?ok=resumed");
  });
  app.post("/hotels", (c) => saveHotel(c, null));
  app.post("/hotels/:id", (c) => saveHotel(c, c.req.param("id")));

  // ---------- Staff (GMs): add and remove people, reset passwords and PINs, register desk PCs.
  const thisDevice = async (c: Context<Env>) => (await deskDevice(c))?.id ?? null;
  const staffError = async (c: Context<Env>, opts: { form?: StaffForm; rowError?: { id: string; text: string } }) =>
    c.html(await staffPage(db, now(), c.get("viewer"), { ...opts, thisDevice: await thisDevice(c) }), 400);

  app.get("/staff", async (c) =>
    c.html(await staffPage(db, now(), c.get("viewer"), { flash: flashFrom(c.req.query("ok")), thisDevice: await thisDevice(c) })),
  );

  app.post("/staff", async (c) => {
    const form = await c.req.parseBody();
    const name = String(form.name ?? "").trim().replace(/\s+/g, " ");
    const role: Role = form.role === "gm" ? "gm" : "desk";
    const pin = String(form.pin ?? "").trim();
    const password = String(form.password ?? "");
    let username = String(form.username ?? "").trim().toLowerCase();
    const values = { name, role, username };
    const error =
      checkName(name)
      ?? ((await nameTaken(db, name)) ? `Someone called ${name} already has an account. Add a last name or initial.` : null)
      ?? (username ? (checkUsername(username) ?? ((await usernameTaken(db, username)) ? `The username ${username} is taken.` : null)) : null)
      ?? (role === "gm" && !password ? "A GM needs a password." : null)
      ?? (role === "desk" && !pin && !password ? "Give them a PIN, a password, or both." : null)
      ?? (pin ? checkPin(pin) : null)
      ?? (password ? checkPassword(password) : null);
    if (error) return staffError(c, { form: { ...values, error } });
    username ||= await suggestUsername(db, name);
    let id: string;
    try {
      id = await createStaff(db, { username, name, role, pin: pin || undefined, password: password || undefined, by: c.get("user") }, now());
    } catch {
      // Two GMs adding the same person at once: the unique index catches it.
      return staffError(c, { form: { ...values, error: "That name or username was just taken. Try again." } });
    }
    await audit(db, c.get("viewer"), "staff.add", now(), id, role === "gm" ? "GM" : "front desk");
    return c.redirect("/staff?ok=added");
  });

  app.post("/staff/:id/reset", async (c) => {
    const id = c.req.param("id");
    const person = await getStaff(db, id);
    if (!person) return c.redirect("/staff");
    const form = await c.req.parseBody();
    const pin = String(form.pin ?? "").trim();
    const password = String(form.password ?? "");
    const error =
      (!pin && !password ? "Enter a new PIN, a new password, or both." : null)
      ?? (pin ? checkPin(pin) : null)
      ?? (password ? checkPassword(password) : null);
    if (error) return staffError(c, { rowError: { id, text: error } });
    // Resetting your own keeps this session; anyone else is signed out everywhere.
    await setSecrets(db, id, { pin: pin || undefined, password: password || undefined }, id === c.get("viewer").id ? c.get("token") : undefined);
    await audit(db, c.get("viewer"), "staff.reset", now(), id, [pin && "PIN", password && "password"].filter(Boolean).join(" and "));
    return c.redirect("/staff?ok=reset");
  });

  app.post("/staff/:id/role", async (c) => {
    const id = c.req.param("id");
    const person = await getStaff(db, id);
    if (!person || id === c.get("viewer").id) return c.redirect("/staff");
    const role: Role = (await c.req.parseBody()).role === "gm" ? "gm" : "desk";
    if (role === person.role) return c.redirect("/staff");
    if (role === "desk" && (await activeGmCount(db)) <= 1) return staffError(c, { rowError: { id, text: "Every hotel needs at least one GM. Make someone else a GM first." } });
    if (role === "gm" && !person.has_password) return staffError(c, { rowError: { id, text: `A GM needs a password. Set one for ${person.name} above first.` } });
    await setRole(db, id, role);
    await audit(db, c.get("viewer"), "staff.role", now(), id, role === "gm" ? "a GM" : "front desk");
    return c.redirect("/staff?ok=role");
  });

  app.post("/staff/:id/remove", async (c) => {
    const id = c.req.param("id");
    const person = await getStaff(db, id);
    if (!person || id === c.get("viewer").id) return c.redirect("/staff");
    if (person.role === "gm" && (await activeGmCount(db)) <= 1) return staffError(c, { rowError: { id, text: "Every hotel needs at least one GM." } });
    await removeStaff(db, id, now());
    await audit(db, c.get("viewer"), "staff.remove", now(), id);
    return c.redirect("/staff?ok=removed");
  });

  // Run on the shared desk computer itself. The cookie lasts as long as browsers allow (400 days).
  app.post("/staff/devices", async (c) => {
    if (!deps.adminPassword) return c.redirect("/staff");
    const label = String((await c.req.parseBody()).label ?? "").trim().slice(0, 40) || "Front desk";
    const device = await registerDevice(db, label, c.get("user"), now());
    await setSignedCookie(c, DEVICE, device.token, sessionKey, { httpOnly: true, sameSite: "Lax", secure: secure(c), path: "/", maxAge: 400 * 86_400 });
    const token = c.get("token");
    if (token) await bindSessionToDevice(db, token, device.id);
    await audit(db, { ...c.get("viewer"), device: { id: device.id, label } }, "device.add", now(), null, label);
    return c.redirect("/staff?ok=device");
  });

  app.post("/staff/devices/:id/remove", async (c) => {
    const id = c.req.param("id");
    const device = (await listDevices(db)).find((d) => d.id === id);
    if (!device) return c.redirect("/staff");
    const here = (await thisDevice(c)) === id;
    await removeDevice(db, id, now());
    await audit(db, c.get("viewer"), "device.remove", now(), null, device.label);
    if (here) deleteCookie(c, DEVICE, { path: "/" });
    // Removing the computer you're on also ends your session on it.
    return c.redirect(here ? "/login" : "/staff?ok=device-removed");
  });

  app.get("/audit", async (c) =>
    c.html(await auditPage(db, now(), { filter: c.req.query("filter"), who: c.req.query("who"), before: c.req.query("before") })),
  );

  // ---------- Your own password and PIN
  const accountFor = async (c: Context<Env>, extra: { flash?: Flash; error?: { form: "password" | "pin"; text: string } } = {}) => {
    const v = c.get("viewer");
    const person = (await getStaff(db, v.id!))!;
    return c.html(accountPage(v, { has: { password: person.has_password, pin: person.has_pin }, ...extra }), extra.error ? 400 : 200);
  };
  const currentOk = async (c: Context<Env>, current: string) => {
    const id = c.get("viewer").id!;
    if (await rateLimited(db, "account", id, 10, now())) return false;
    return (await verifySecret(current, await passwordHash(db, id))) || (await verifySecret(current, (await pinHash(db, id))?.pin_hash));
  };

  app.get("/account", async (c) => (c.get("viewer").id ? accountFor(c, { flash: flashFrom(c.req.query("ok")) }) : c.redirect("/issues")));

  app.post("/account/:what", async (c) => {
    const what = c.req.param("what");
    if (!c.get("viewer").id || (what !== "pin" && what !== "password")) return c.redirect("/issues");
    const form = await c.req.parseBody();
    const value = String(form[what] ?? "").trim();
    const error = what === "pin" ? checkPin(value) : checkPassword(String(form.password ?? ""));
    if (error) return accountFor(c, { error: { form: what, text: error } });
    if (!(await currentOk(c, String(form.current ?? "")))) return accountFor(c, { error: { form: what, text: "Your current password or PIN isn’t right." } });
    await setSecrets(db, c.get("viewer").id!, what === "pin" ? { pin: value } : { password: String(form.password) }, c.get("token"));
    await audit(db, c.get("viewer"), "staff.reset", now(), c.get("viewer").id, what === "pin" ? "PIN" : "password");
    return c.redirect(`/account?ok=${what}-saved`);
  });

  return app;
}

/** A tick holds this lease; longer than the function's maxDuration (vercel.json) so a live tick keeps it. */
export const TICK_LEASE_SECONDS = 120;

/** One scheduler pass: apply events, send due messages, escalations and follow-ups, sync reviews. */
/** Constant-time check of an "Authorization: Bearer ..." header. */
export function bearerMatches(header: string | undefined, secret: string) {
  const digest = (v: string) => createHash("sha256").update(v).digest();
  return !!header && timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

/**
 * One pass of scheduled work. Two can start at once (a slow tick overlapping the next cron call, or
 * two schedulers configured during a migration between them): the lease lets one run and the other
 * return straight away. Each worker also claims its own rows, so even an expired lease can't double-send.
 */
export async function tick(deps: AppDeps) {
  const now = deps.now?.() ?? new Date();
  const release = await acquireLease(deps.db, "tick", TICK_LEASE_SECONDS * 1_000, now);
  if (!release) return { skipped: true as const, reason: "another tick is running" };
  const started = performance.now();

  // Each step runs even if an earlier one failed; failures are recorded for Operations.
  const errors: string[] = [];
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try { return await fn(); } catch (err) { errors.push(`${name}: ${(err as Error).message}`); return undefined; }
  };
  // Stop starting new Claude drafts once the budget is spent, well inside the function timeout.
  const deadline = Date.now() + (deps.tickBudgetMs ?? 40_000);
  try {
    await step("retention", () => runRetentionIfDue(deps.db, now, Number(process.env.PII_RETENTION_DAYS ?? 365)));
    const outbound = await step("outbox", () => dispatchOutbox(deps.db, deps.messenger, now));
    const events = await step("events", () => processEvents(deps.db));
    const jobs = await step("scheduled texts", () => runDueJobs(deps.db, { messenger: deps.messenger, now: () => now }));
    const cases = await step("escalations and follow-ups", () => runCaseTimers(deps.db, deps.messenger, now));
    const reviews: Record<string, unknown> = {};
    for (const p of (await step("reviews", () => listProperties(deps.db))) ?? []) {
      if (!deps.source.supports(p)) continue;
      const key = `reviews:${p.id}`;
      const [previous] = await deps.db.query<{ value: string }>("select value from sync_state where key = $1", [key]);
      let lastOk: string | undefined;
      try { lastOk = previous ? (JSON.parse(previous.value) as { lastOk?: string }).lastOk : undefined; } catch {}
      try {
        const result = await syncReviews(deps.db, p.id, { ...deps, deadline });
        reviews[p.id] = result;
        await deps.db.query(`insert into sync_state (key, value, updated_at) values ($1, $2, $3)
          on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
          [key, JSON.stringify({ lastAttempt: now, ok: result.errors.length === 0, errors: result.errors, lastOk: result.errors.length === 0 ? now : lastOk }), now.toISOString()]);
      } catch (err) {
        reviews[p.id] = { error: (err as Error).message };
        await step("reviews", () => deps.db.query(`insert into sync_state (key, value, updated_at) values ($1, $2, $3)
          on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
          [key, JSON.stringify({ lastAttempt: now, ok: false, error: (err as Error).message, lastOk }), now.toISOString()]));
      }
    }
    await deps.db.query(`insert into sync_state (key, value, updated_at) values ('scheduler', $1, $2)
      on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      [JSON.stringify({ ok: errors.length === 0, errors }), now.toISOString()]);
    const ok = errors.length === 0;
    await recordTick(deps.db, { ok, startedAt: now.toISOString(), ms: Math.round(performance.now() - started), error: errors.join("; ") || undefined }, now);
    return { ok, errors, events, jobs, cases, reviews, outbound };
  } catch (err) {
    await recordTick(deps.db, { ok: false, startedAt: now.toISOString(), ms: Math.round(performance.now() - started), error: (err as Error).message }, now).catch(() => {});
    log.error("tick.failed", { name: err instanceof Error ? err.name : "unknown" });
    throw err;
  } finally {
    await release().catch(() => {});
  }
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
  connected: { text: "Texts started. That guest can get texts from the desk now." },
  hotel_added: { text: "Hotel added. Next, set its texting number and Google listing." },
  hotel_saved: { text: "Saved." },
  paused: { text: "Guest texts paused. Staff alerts still go out." },
  resumed: { text: "Guest texts resumed. Held texts go out on the next run." },
  posted: { text: "Reply posted to Google." },
  dismissed: { text: "Draft dismissed. Nothing was posted." },
  restored: { text: "Draft is back in the queue." },
  "gm-only": { text: "That page is for GMs. Ask your GM if you need something from it.", tone: "err" },
  added: { text: "Added. Tell them their PIN or password in person." },
  reset: { text: "Saved. They're signed out everywhere until they use the new one." },
  role: { text: "Role changed. It applies right away." },
  removed: { text: "Removed and signed out. Their name stays in the activity log." },
  device: { text: "This computer is now a front desk PC. Staff switch in with their name and PIN." },
  "device-removed": { text: "That computer no longer works as a front desk PC." },
  "pin-saved": { text: "PIN saved." },
  "password-saved": { text: "Password saved. You're still signed in here; other devices need the new password." },
};
const flashFrom = (code: string | undefined) => (code ? FLASH[code] : undefined);

/** Why a text to a guest didn't go, in words the desk can act on. */
function sendError(raw: string): string {
  if (raw === "message is empty") return "Write a message first.";
  if (raw === "issue not found") return "This issue isn’t here anymore. Refresh the page.";
  if (raw.includes("opted out")) return "Not sent. This guest texted STOP, so we can’t text them. Call the room instead.";
  if (raw.includes("no SMS consent")) return "Not sent. This guest hasn’t agreed to texts. Call the room, or ask them to scan the QR sign at the desk.";
  if (raw.includes("paused")) return "Not sent. Guest texts are paused for this hotel. Call the room, or ask your GM to resume texts.";
  if (raw.includes("no phone")) return "Not sent. We don’t have a mobile number for this guest. Call the room instead.";
  console.error("guest text failed:", raw);
  return "Not sent. The text service didn’t take it. Try again in a minute; if it keeps failing, call the room.";
}
