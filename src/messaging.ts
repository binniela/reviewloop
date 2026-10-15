import { randomUUID } from "node:crypto";
/** Outbound guest messages. Console mode records instead of sending, for development and demos. */

export interface OutboundMessage {
  channel: "sms" | "email";
  to: string;
  body: string;
  subject?: string;
  fromName?: string;
  /** Sending number for SMS (the hotel's own Twilio number). Falls back to the messaging service. */
  from?: string | null;
  outboxId?: string;
}

export interface Messenger {
  /** Persist side effects inside a DB transaction; dispatch after commit. */
  deferred?: boolean;
  send(msg: OutboundMessage): Promise<{ providerId: string }>;
}

export class ConsoleMessenger implements Messenger {
  sent: OutboundMessage[] = [];
  constructor(private readonly quiet = false) {}
  async send(msg: OutboundMessage) {
    this.sent.push(msg);
    if (!this.quiet) console.log(`[${msg.channel} -> ${msg.to}] ${msg.subject ? `${msg.subject}: ` : ""}${msg.body}`);
    return { providerId: `console-${randomUUID()}` };
  }
}

/** A request might have succeeded remotely. Automatic resend could duplicate it. */
export class DeliveryUncertainError extends Error {}

/** The provider refused this message for good (bad number, unsubscribed, blocked). Retrying won't help. */
export class ProviderRejectedError extends Error {
  constructor(message: string, readonly code: number | null) { super(message); }
}
/**
 * The provider refused our credentials (a wrong or rotated token). Nothing is wrong with the
 * message, so it waits and retries until someone fixes the setting, and Operations goes red.
 */
export class ProviderConfigError extends Error {}
export const CREDENTIALS_ERROR = "Text provider rejected our credentials";

/** Rate limits and server errors are worth retrying; any other 4xx is a final answer. */
const permanent = (status: number) => status >= 400 && status < 500 && status !== 429;
const credentials = (status: number) => status === 401 || status === 403;
async function providerFetch(url: string, init: RequestInit) {
  try { return await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }); }
  catch (error) { throw new DeliveryUncertainError(`Provider send outcome unknown: ${(error as Error).message}`); }
}
async function providerJson(res: Response): Promise<Record<string, unknown>> {
  try { return await res.json() as Record<string, unknown>; }
  catch { throw new DeliveryUncertainError(`Provider returned unreadable response (${res.status}); reconcile before retrying`); }
}

export class TwilioSms {
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly messagingServiceSid: string,
    private readonly statusCallback?: string,
  ) {}
  async send(to: string, body: string, from?: string | null, outboxId?: string) {
    const callback = this.statusCallback ? new URL(this.statusCallback) : null;
    if (callback && outboxId) callback.searchParams.set("rl_outbox", outboxId);
    const res = await providerFetch(`https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(
        { ...(from ? { To: to, Body: body, From: from } : { To: to, Body: body, MessagingServiceSid: this.messagingServiceSid }),
          ...(callback ? { StatusCallback: callback.toString() } : {}) },
      ),
    });
    const json = (await providerJson(res)) as { sid?: string; message?: string; code?: number };
    if (!res.ok || !json.sid) {
      const message = `Twilio ${res.status}${json.code ? ` (code ${json.code})` : ""}: ${json.message ?? "send failed"}`;
      if (credentials(res.status)) throw new ProviderConfigError(`${CREDENTIALS_ERROR}. ${message}`);
      throw permanent(res.status) ? new ProviderRejectedError(message, json.code ?? null) : new Error(message);
    }
    return json.sid;
  }
}

export class ResendEmail {
  constructor(
    private readonly apiKey: string,
    private readonly fromAddress: string,
  ) {}
  async send(to: string, subject: string, text: string, fromName?: string) {
    const res = await providerFetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: fromName ? `${fromName} <${this.fromAddress}>` : this.fromAddress, to, subject, text }),
    });
    const json = (await providerJson(res)) as { id?: string; message?: string };
    if (!res.ok || !json.id) {
      const message = `Resend ${res.status}: ${json.message ?? "send failed"}`;
      if (credentials(res.status)) throw new ProviderConfigError(`${CREDENTIALS_ERROR}. ${message}`);
      throw permanent(res.status) ? new ProviderRejectedError(message, null) : new Error(message);
    }
    return json.id;
  }
}

export class LiveMessenger implements Messenger {
  constructor(
    private readonly sms: TwilioSms | null,
    private readonly email: ResendEmail | null,
  ) {}
  async send(msg: OutboundMessage) {
    if (msg.channel === "sms") {
      if (!this.sms) throw new Error("SMS is not configured (TWILIO_* env vars)");
      return { providerId: await this.sms.send(msg.to, msg.body, msg.from, msg.outboxId) };
    }
    if (!this.email) throw new Error("Email is not configured (RESEND_API_KEY, EMAIL_FROM)");
    return { providerId: await this.email.send(msg.to, msg.subject ?? "", msg.body, msg.fromName) };
  }
}

export function messengerFromEnv(env = process.env): Messenger {
  if (env.MESSAGING_MODE !== "live") return new ConsoleMessenger();
  // Behind Vercel deployment protection, Twilio's delivery callbacks need the automation bypass token.
  const bypass = env.VERCEL_AUTOMATION_BYPASS_SECRET ? `?x-vercel-protection-bypass=${encodeURIComponent(env.VERCEL_AUTOMATION_BYPASS_SECRET)}` : "";
  const sms =
    env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN
      ? new TwilioSms(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, env.TWILIO_MESSAGING_SERVICE_SID ?? "", env.PUBLIC_URL ? `${env.PUBLIC_URL.replace(/\/$/, "")}/webhooks/twilio/status${bypass}` : undefined)
      : null;
  const email = env.RESEND_API_KEY && env.EMAIL_FROM ? new ResendEmail(env.RESEND_API_KEY, env.EMAIL_FROM) : null;
  return new LiveMessenger(sms, email);
}
