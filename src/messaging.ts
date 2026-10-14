/** Outbound guest messages. Console mode records instead of sending, for development and demos. */

export interface OutboundMessage {
  channel: "sms" | "email";
  to: string;
  body: string;
  subject?: string;
  fromName?: string;
  /** Sending number for SMS (the hotel's own Twilio number). Falls back to the messaging service. */
  from?: string | null;
}

export interface Messenger {
  send(msg: OutboundMessage): Promise<{ providerId: string }>;
}

export class ConsoleMessenger implements Messenger {
  sent: OutboundMessage[] = [];
  constructor(private readonly quiet = false) {}
  async send(msg: OutboundMessage) {
    this.sent.push(msg);
    if (!this.quiet) console.log(`[${msg.channel} -> ${msg.to}] ${msg.subject ? `${msg.subject}: ` : ""}${msg.body}`);
    return { providerId: `console-${this.sent.length}` };
  }
}

export class TwilioSms {
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly messagingServiceSid: string,
  ) {}
  async send(to: string, body: string, from?: string | null) {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(
        from ? { To: to, Body: body, From: from } : { To: to, Body: body, MessagingServiceSid: this.messagingServiceSid },
      ),
    });
    const json = (await res.json()) as { sid?: string; message?: string };
    if (!res.ok || !json.sid) throw new Error(`Twilio ${res.status}: ${json.message ?? "send failed"}`);
    return json.sid;
  }
}

export class ResendEmail {
  constructor(
    private readonly apiKey: string,
    private readonly fromAddress: string,
  ) {}
  async send(to: string, subject: string, text: string, fromName?: string) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: fromName ? `${fromName} <${this.fromAddress}>` : this.fromAddress, to, subject, text }),
    });
    const json = (await res.json()) as { id?: string; message?: string };
    if (!res.ok || !json.id) throw new Error(`Resend ${res.status}: ${json.message ?? "send failed"}`);
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
      return { providerId: await this.sms.send(msg.to, msg.body, msg.from) };
    }
    if (!this.email) throw new Error("Email is not configured (RESEND_API_KEY, EMAIL_FROM)");
    return { providerId: await this.email.send(msg.to, msg.subject ?? "", msg.body, msg.fromName) };
  }
}

export function messengerFromEnv(env = process.env): Messenger {
  if (env.MESSAGING_MODE !== "live") return new ConsoleMessenger();
  const sms =
    env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN
      ? new TwilioSms(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, env.TWILIO_MESSAGING_SERVICE_SID ?? "")
      : null;
  const email = env.RESEND_API_KEY && env.EMAIL_FROM ? new ResendEmail(env.RESEND_API_KEY, env.EMAIL_FROM) : null;
  return new LiveMessenger(sms, email);
}
