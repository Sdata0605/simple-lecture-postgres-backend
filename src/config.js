// Startup checks. Reports which settings are missing by NAME only, never by value.
const REQUIRED_ALWAYS = ["DATABASE_URL", "JWT_SECRET"];

// Needed only when a delivery mode is switched on.
const REQUIRED_FOR_SMTP = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS"];
const REQUIRED_FOR_LIVE_SMS = ["NETTYFISH_USER", "NETTYFISH_PASSWORD", "NETTYFISH_SENDER_ID", "NETTYFISH_LOGIN_TEMPLATE_ID", "NETTYFISH_SIGNUP_TEMPLATE_ID"];
// WhatsApp is optional: without WACTO_API_TOKEN, WhatsApp requests return a clear error instead.

export function missingSettings(env = process.env) {
  const missing = REQUIRED_ALWAYS.filter((k) => !env[k]);
  if (env.JWT_SECRET && env.JWT_SECRET.length < 32) missing.push("JWT_SECRET (must be at least 32 characters)");
  if (env.MAIL_MODE === "smtp") missing.push(...REQUIRED_FOR_SMTP.filter((k) => !env[k]));
  if (env.MESSAGE_MODE === "live") {
    missing.push(...REQUIRED_FOR_LIVE_SMS.filter((k) => !env[k]));
  }
  return missing;
}

// Refuses to start on a missing setting, so a deploy cannot silently fall back to dry-run.
export function assertConfigured(env = process.env) {
  const missing = missingSettings(env);
  if (missing.length) {
    throw new Error(`backend cannot start. Missing or invalid settings: ${missing.join(", ")}`);
  }
  console.log(`[config] mail=${env.MAIL_MODE || "dry-run"} messages=${env.MESSAGE_MODE || "dry-run"}`);
}
