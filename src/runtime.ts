/** Live deployments must never silently fall back to unauthenticated/mock operation. */
export function validateRuntime(env: NodeJS.ProcessEnv = process.env) {
  const deployed = env.NODE_ENV === "production" || env.MESSAGING_MODE === "live";
  if (!deployed) return;
  for (const name of ["ADMIN_PASSWORD", "CRON_SECRET", "PUBLIC_URL", "DATABASE_URL"]) {
    if (!env[name]?.trim()) throw new Error(`${name} is required in production/live mode`);
  }
  if (new URL(env.PUBLIC_URL!).protocol !== "https:") throw new Error("PUBLIC_URL must use HTTPS in production/live mode");
  if (env.ALLOW_UNSIGNED_WEBHOOKS === "1") throw new Error("Unsigned webhooks are forbidden in production/live mode");
  if (env.NODE_ENV === "production" && env.MESSAGING_MODE !== "live") throw new Error("Production requires MESSAGING_MODE=live");
  if (env.MESSAGING_MODE === "live" && (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN)) {
    throw new Error("Live messaging requires Twilio credentials");
  }
  if (![env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REFRESH_TOKEN].every(Boolean)) {
    throw new Error("Production/live mode requires Google credentials; mock reviews are local-only");
  }
}
