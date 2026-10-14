/**
 * Checks a live deployment from the outside, before and after the real-phone walk.
 *
 *   PUBLIC_URL=https://staging.example.com CRON_SECRET=... TWILIO_AUTH_TOKEN=... \
 *   [VERCEL_AUTOMATION_BYPASS_SECRET=...] npm run staging:check
 *
 * It sends no texts. The signed-webhook check uses a status callback for a made-up MessageSid,
 * which records a receipt nobody's message matches.
 */
import { twilioSignature } from "../src/inbound/twilioSignature.js";

try { process.loadEnvFile(); } catch {}
const base = process.env.PUBLIC_URL?.replace(/\/$/, "");
const { CRON_SECRET, TWILIO_AUTH_TOKEN, VERCEL_AUTOMATION_BYPASS_SECRET: bypass } = process.env;
if (!base || !CRON_SECRET || !TWILIO_AUTH_TOKEN) {
  console.error("Set PUBLIC_URL, CRON_SECRET and TWILIO_AUTH_TOKEN (and VERCEL_AUTOMATION_BYPASS_SECRET if deployment protection is on).");
  process.exit(2);
}
const q = bypass ? `?x-vercel-protection-bypass=${encodeURIComponent(bypass)}` : "";
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};

const health = await fetch(`${base}/healthz${q}`);
const healthBody = await health.json().catch(() => ({}));
check("/healthz answers with the database reachable", (healthBody as { db?: string }).db === "ok", JSON.stringify(healthBody));
check("scheduler has run recently", health.status === 200, `HTTP ${health.status}`);

const noAuth = await fetch(`${base}/cron/tick${q}`);
check("/cron/tick refuses a request without the secret", noAuth.status === 401, `HTTP ${noAuth.status}`);
const tick = await fetch(`${base}/cron/tick${q}`, { headers: { Authorization: `Bearer ${CRON_SECRET}` } });
check("/cron/tick runs with the secret", tick.status === 200, `HTTP ${tick.status} ${(await tick.text()).slice(0, 200)}`);

const params = { From: "+15005550006", To: "+15005550006", Body: "staging check", MessageSid: "SMstagingcheck" };
const unsigned = await fetch(`${base}/webhooks/twilio/sms${q}`, { method: "POST", body: new URLSearchParams(params) });
check("inbound SMS webhook refuses an unsigned request", unsigned.status === 403, `HTTP ${unsigned.status}`);
const forged = await fetch(`${base}/webhooks/twilio/sms${q}`, {
  method: "POST", body: new URLSearchParams(params), headers: { "X-Twilio-Signature": twilioSignature("wrong-token", `${base}/webhooks/twilio/sms${q}`, params) },
});
check("inbound SMS webhook refuses a signature made with another token", forged.status === 403, `HTTP ${forged.status}`);

const receipt = { MessageSid: "SMstagingcheck", MessageStatus: "delivered" };
const statusUrl = `${base}/webhooks/twilio/status${q}`;
const signed = await fetch(statusUrl, {
  method: "POST", body: new URLSearchParams(receipt), headers: { "X-Twilio-Signature": twilioSignature(TWILIO_AUTH_TOKEN, statusUrl, receipt) },
});
check("a correctly signed Twilio callback is accepted (PUBLIC_URL matches what Twilio calls)", signed.status === 204, `HTTP ${signed.status}`);

const checkin = await fetch(`${base}/checkin/${encodeURIComponent(process.env.PROPERTY_ID ?? "")}${q}`);
if (process.env.PROPERTY_ID) check("check-in page is public", checkin.status === 200, `HTTP ${checkin.status}`);

console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
