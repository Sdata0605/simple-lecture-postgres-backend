// Provider health for the admin API (GET /admin/api/providers/status).
// SAFE checks only: nothing here sends an OTP, SMS, WhatsApp message or email.
// A provider is listed when its credential env vars are present. It is "configured" (live) only
// when its live mode is on. In dry-run / test mode no network call is made.
import nodemailer from "nodemailer";
import { query } from "./db.js";

const TIMEOUT_MS = 5000;
const CACHE_MS = 60 * 1000;

const mailMode = () => process.env.MAIL_MODE || "dry-run";
const messageMode = () => process.env.MESSAGE_MODE || "dry-run";
// Test mode: either the mail or the message mode is dry-run. Nothing live is attempted then.
const testMode = () => mailMode() === "dry-run" || messageMode() === "dry-run";
const notTestMode = () => !testMode();

function withTimeout(promise, ms = TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Short, fixed reasons only. Raw provider bodies, URLs and messages are never returned.
function classify(err) {
  if (err?.status) return `HTTP ${err.status}`;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "timeout";
  if (err?.code === "EAUTH") return "auth failed";
  return "unreachable";
}

async function drain(res) {
  await res.body?.cancel().catch(() => {});
}

// Sends a GET with auth headers. Throws with status when the provider answers non-2xx.
async function httpCheck(url, init = {}) {
  const res = await fetch(url, { method: "GET", ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  await drain(res);
  if (!res.ok) throw Object.assign(new Error("http"), { status: res.status });
}

// Any HTTP answer at all counts as reachable. No credentials are sent.
async function reachableCheck(url) {
  const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(TIMEOUT_MS) });
  await drain(res);
}

const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

async function checkSmtp() {
  const port = Number(process.env.SMTP_PORT || 465);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  });
  try {
    await withTimeout(transporter.verify()); // connection and auth only, no message is sent
  } finally {
    transporter.close();
  }
}

async function checkB2() {
  const base = (process.env.B2_API_URL || "https://api.backblazeb2.com").replace(/\/$/, "");
  await httpCheck(`${base}/b2api/v2/b2_authorize_account`, {
    headers: { Authorization: basic(process.env.B2_KEY_ID, process.env.B2_APPLICATION_KEY) },
  });
}

async function checkRazorpay() {
  const base = (process.env.RAZORPAY_API_BASE || "https://api.razorpay.com").replace(/\/$/, "");
  // Read-only list call with the count capped at 1.
  await httpCheck(`${base}/v1/payments?count=1`, {
    headers: { Authorization: basic(process.env.RAZORPAY_KEY_ID, process.env.RAZORPAY_KEY_SECRET) },
  });
}

// Display name, env vars that must all be present, the live-mode test, the log rows that
// record this provider's outcomes, and the safe check (null when none exists).
export const PROVIDERS = [
  {
    key: "smtp", name: "SMTP", env: ["SMTP_HOST"],
    isLive: () => mailMode() === "smtp",
    log: { category: "otp.email" },
    check: checkSmtp,
  },
  {
    key: "nettyfish", name: "Nettyfish SMS", env: ["NETTYFISH_USER", "NETTYFISH_PASSWORD"],
    isLive: () => messageMode() === "live",
    log: { category: "otp.sms" },
    check: null, // the only Nettyfish API is the send endpoint
  },
  {
    key: "wacto", name: "Wacto WhatsApp", env: ["WACTO_API_TOKEN"],
    isLive: () => messageMode() === "live",
    log: { category: "otp.whatsapp" },
    check: null, // the only Wacto API is the template send endpoint
  },
  {
    key: "b2", name: "Backblaze B2", env: ["B2_KEY_ID", "B2_APPLICATION_KEY"],
    isLive: notTestMode,
    log: { category: "provider", provider: "b2" },
    check: checkB2,
  },
  {
    key: "razorpay", name: "Razorpay", env: ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"],
    isLive: notTestMode,
    log: { category: "provider", provider: "razorpay" },
    check: checkRazorpay,
  },
  {
    key: "kie", name: "KIE AI", env: ["KIE_AI_API_KEY"],
    isLive: notTestMode,
    log: { category: "provider", provider: "kie" },
    check: () => reachableCheck("https://api.kie.ai/"),
  },
  {
    key: "sarvam", name: "Sarvam", env: ["SARVAM_API_KEY"],
    isLive: notTestMode,
    log: { category: "provider", provider: "sarvam" },
    check: () => reachableCheck("https://api.sarvam.ai/"),
  },
];

// Providers whose credential env vars are present. Used by the route and by the tests.
export function configuredProviders(env = process.env) {
  return PROVIDERS.filter((p) => p.env.every((name) => Boolean(env[name])));
}

const iso = (d) => (d ? new Date(d).toISOString() : null);
const later = (a, b) => (a && b ? (a > b ? a : b) : a || b || null);

// Latest success and failure per (category, provider). Keys: "category|outcome|provider".
async function lastLogTimes(providers) {
  const cats = [...new Set(providers.map((p) => p.log.category))];
  const map = new Map();
  try {
    const { rows } = await query(
      `SELECT category, outcome, details->>'provider' AS provider, max(ts) AS ts
         FROM public.system_logs
        WHERE category = ANY($1::text[]) AND outcome IN ('success', 'failed')
        GROUP BY 1, 2, 3`,
      [cats]
    );
    for (const r of rows) map.set(`${r.category}|${r.outcome}|${r.provider ?? ""}`, r.ts);
  } catch (e) {
    console.error(JSON.stringify({ level: "error", step: "provider-status.log_query_failed", message: e.message }));
  }
  return map;
}

// Results of live checks run in this process. Kept in memory so a health check does not write
// a row into system_logs every minute.
const memo = new Map(); // key -> { success, failure } (Dates)

async function runOne(p, logs) {
  const lk = (outcome) => logs.get(`${p.log.category}|${outcome}|${p.log.provider ?? ""}`);
  const base = {
    name: p.name,
    configured: false,
    reachable: null,
    last_success_at: iso(later(lk("success"), memo.get(p.key)?.success)),
    last_failure_at: iso(later(lk("failed"), memo.get(p.key)?.failure)),
    last_error: null,
    latency_ms: null,
  };
  if (!p.isLive()) return { ...base, last_error: "live mode off (dry-run)" };
  base.configured = true;
  if (!p.check) return { ...base, last_error: "no safe check available" };

  const started = Date.now();
  let result;
  try {
    await p.check();
    result = { ok: true };
  } catch (e) {
    result = { ok: false, error: classify(e) };
  }
  const mem = memo.get(p.key) || {};
  const now = new Date();
  memo.set(p.key, { ...mem, [result.ok ? "success" : "failure"]: now });
  return {
    ...base,
    reachable: result.ok,
    latency_ms: Date.now() - started,
    last_success_at: iso(later(lk("success"), memo.get(p.key)?.success)),
    last_failure_at: iso(later(lk("failed"), memo.get(p.key)?.failure)),
    last_error: result.ok ? null : result.error,
  };
}

async function buildStatus() {
  const providers = configuredProviders();
  const logs = await lastLogTimes(providers);
  const checked_at = new Date().toISOString();
  const results = await Promise.all(providers.map((p) => runOne(p, logs)));
  return results.map((r) => ({ ...r, checked_at }));
}

// Cached for 60 seconds, one shared entry.
let cache = null;
export function getProviderStatus() {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;
  const value = buildStatus();
  cache = { value, expiresAt: now + CACHE_MS };
  return value;
}

export function _resetProviderStatusCache() {
  cache = null;
  memo.clear();
}
