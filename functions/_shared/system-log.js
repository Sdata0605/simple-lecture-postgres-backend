// Structured event log stored in public.system_logs (see migrations/system-logs.sql).
// Writes are async and never throw. If the DB write fails, the entry is kept in an in-memory
// ring of the last 500 entries and printed to stdout, so logging can never break a request.
// Secrets are redacted by key name, and identifiers are masked before storage.
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { query } from "./db.js";

export const CATEGORIES = ["http", "auth", "admin", "otp.email", "otp.sms", "otp.whatsapp", "provider", "frontend"];
export const OUTCOMES = ["success", "failed", "info"];

// Carries the request ID through async code, so existing log.* calls get it without changes.
export const requestContext = new AsyncLocalStorage();
export const currentRequestId = () => requestContext.getStore()?.requestId;

// Maps existing backend step names (see functions/_shared/log.js) to system_logs events.
// Only steps listed here are stored. Everything else stays in stdout and the log file.
const STEP_EVENTS = [
  [/^auth-token\.password\.ok$/, { category: "auth", event: "login.success", outcome: "success" }],
  [/^auth-token\.password\.(wrong_password|no_account)$/, { category: "auth", event: "login.failed", outcome: "failed" }],
  [/^auth-token\.refresh\.ok$/, { category: "auth", event: "refresh.success", outcome: "success" }],
  [/^auth-token\.refresh\.invalid_token$/, { category: "auth", event: "refresh.failed", outcome: "failed" }],
  [/^auth-signup\.start$/, { category: "auth", event: "signup.requested", outcome: "info" }],
  [/^auth-signup\.conflict$/, { category: "auth", event: "signup.failed", outcome: "failed" }],
  [/^auth-logout\.request$/, { category: "auth", event: "logout", outcome: "info" }],
  [/^auth-token\.exception$/, { category: "auth", event: "login.server_error", outcome: "failed" }],
  [/^auth-signup\.exception$/, { category: "auth", event: "signup.server_error", outcome: "failed" }],
  [/^auth-user\.bad_token$/, { category: "auth", event: "session.invalid", outcome: "failed" }],
  [/^send-email-otp\.checks_passed$/, { category: "otp.email", event: "otp.requested", outcome: "info" }],
  [/^send-email-otp\.sent$/, { category: "otp.email", event: "otp.sent", outcome: "success" }],
  [/^send-email-otp\.rejected$/, { category: "otp.email", event: "otp.rejected", outcome: "failed" }],
  [/^send-email-otp\.exception$/, { category: "otp.email", event: "otp.send_failed", outcome: "failed" }],
  [/^verify-email-otp\.record_found$/, { category: "otp.email", event: "otp.verify_requested", outcome: "info" }],
  [/^verify-email-otp\.code_consumed$/, { category: "otp.email", event: "otp.verified", outcome: "success" }],
  [/^verify-email-otp\.wrong_code$/, { category: "otp.email", event: "otp.wrong_code", outcome: "failed" }],
  [/^verify-email-otp\.rejected$/, { category: "otp.email", event: "otp.rejected", outcome: "failed" }],
  [/^verify-email-otp\.session_issued$/, { category: "otp.email", event: "otp.session_issued", outcome: "success" }],
  [/^verify-email-otp\.exception$/, { category: "otp.email", event: "otp.verify_failed", outcome: "failed" }],
  [/^send-phone-otp\.checks_passed$/, { category: "otp.sms", event: "otp.requested", outcome: "info" }],
  [/^send-phone-otp\.sent$/, { category: "otp.sms", event: "otp.sent", outcome: "success" }],
  [/^send-phone-otp\.rejected$/, { category: "otp.sms", event: "otp.rejected", outcome: "failed" }],
  [/^send-phone-otp\.delivery_failed$/, { category: "otp.sms", event: "otp.send_failed", outcome: "failed" }],
  [/^send-phone-otp\.exception$/, { category: "otp.sms", event: "otp.send_failed", outcome: "failed" }],
  [/^verify-phone-otp\.record_found$/, { category: "otp.sms", event: "otp.verify_requested", outcome: "info" }],
  [/^verify-phone-otp\.code_consumed$/, { category: "otp.sms", event: "otp.verified", outcome: "success" }],
  [/^verify-phone-otp\.wrong_code$/, { category: "otp.sms", event: "otp.wrong_code", outcome: "failed" }],
  [/^verify-phone-otp\.rejected$/, { category: "otp.sms", event: "otp.rejected", outcome: "failed" }],
  [/^verify-phone-otp\.session_issued$/, { category: "otp.sms", event: "otp.session_issued", outcome: "success" }],
  [/^verify-phone-otp\.exception$/, { category: "otp.sms", event: "otp.verify_failed", outcome: "failed" }],
  [/^send-password-reset-otp\.(no_account|mail_failed|exception)$/, { category: "auth", event: "password_reset.send_failed", outcome: "failed" }],
  [/^send-password-reset-otp\.code_stored$/, { category: "auth", event: "password_reset.requested", outcome: "info" }],
  [/^verify-password-reset-otp\.wrong_code$/, { category: "auth", event: "password_reset.wrong_code", outcome: "failed" }],
  [/^reset-password-with-token\.token_valid$/, { category: "auth", event: "password_reset.token_valid", outcome: "success" }],
  [/^reset-password-with-token\.exception$/, { category: "auth", event: "password_reset.failed", outcome: "failed" }],
];

// Plain-language text per event, used when a step gives no specific reason.
export const EVENT_TEXT = {
  "login.success": "Logged in successfully",
  "login.failed": "Login failed",
  "login.server_error": "Login failed: server error (see server log)",
  "refresh.success": "Session refreshed",
  "refresh.failed": "Session refresh failed: token invalid or expired",
  "logout": "Logged out",
  "signup.requested": "Sign-up started",
  "signup.failed": "Sign-up failed",
  "signup.server_error": "Sign-up failed: server error (see server log)",
  "session.invalid": "Request used an invalid or expired session",
  "otp.requested": "OTP requested",
  "otp.sent": "OTP sent",
  "otp.send_failed": "OTP could not be sent: provider error (see server log)",
  "otp.rejected": "OTP request rejected",
  "otp.verify_requested": "OTP entered for verification",
  "otp.verified": "OTP verified",
  "otp.wrong_code": "Wrong OTP code entered",
  "otp.verify_failed": "OTP verification failed: server error (see server log)",
  "otp.session_issued": "Session issued after OTP verification",
  "password_reset.requested": "Password reset code sent",
  "password_reset.send_failed": "Password reset code could not be sent",
  "password_reset.wrong_code": "Wrong password reset code entered",
  "password_reset.token_valid": "Password reset token accepted",
  "password_reset.failed": "Password reset failed: server error (see server log)",
};

// Returns { category, event, outcome } for a step name, or null when the step is not stored.
export function classifyStep(step) {
  for (const [re, ev] of STEP_EVENTS) if (re.test(step)) return ev;
  return null;
}

// Masks e-mail addresses and phone-like digit runs (8 or more digits) inside free text.
// Provider error messages and stack traces can echo them. Shorter numbers stay readable.
export function scrubText(text) {
  return String(text || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "[redacted-jwt]")
    .replace(/[^\s@<>"']+@[^\s@<>"']+/g, (m) => maskIdentifier(m))
    .replace(/\+?\d[\d\s-]{7,}\d/g, (m) => (m.replace(/\D/g, "").length >= 8 ? maskIdentifier(m) : m));
}
const SECRET_KEY = /pass|otp|token|secret|authorization|cookie|api[_-]?key|service[_-]?role|code$/i;
const MAX_STRING = 500;
const RING_SIZE = 500;

export const fallbackRing = [];

export function newRequestId() {
  return crypto.randomBytes(6).toString("hex");
}

// alice@gmail.com -> a***@gmail.com ; 9876543210 -> ******3210
export function maskIdentifier(value) {
  if (value === undefined || value === null || value === "") return null;
  const s = String(value).trim();
  if (s.includes("@")) {
    const [local, domain] = s.split("@");
    return `${(local || "").slice(0, 1)}***@${domain || ""}`;
  }
  const digits = s.replace(/\D/g, "");
  if (digits.length >= 4) return "******" + digits.slice(-4);
  return "****";
}

// Removes secret-like keys, masks identifier-like keys and truncates long strings, recursively.
export function redact(value, depth = 0) {
  if (depth > 5) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubText(value.length > MAX_STRING ? value.slice(0, MAX_STRING) + "…" : value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) return redact({ name: value.name, message: value.message, code: value.code }, depth + 1);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) out[k] = "[redacted]";
      else if (/^(email|phone|phone_number|mobile)$/i.test(k)) out[k] = maskIdentifier(v);
      else out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

// Validates and normalises one event. Returns the row to store.
export function buildRow({ category, event, outcome = "info", statusCode, message = "", identifier, requestId, durationMs, details }) {
  return {
    category: CATEGORIES.includes(category) ? category : "http",
    event: String(event || "event").slice(0, 80),
    outcome: OUTCOMES.includes(outcome) ? outcome : "info",
    status_code: Number.isInteger(statusCode) ? statusCode : null,
    message: scrubText(redact(String(message || ""))).slice(0, 300),
    masked_identifier: maskIdentifier(identifier),
    request_id: requestId ? String(requestId).slice(0, 64) : null,
    duration_ms: Number.isFinite(durationMs) ? Math.round(durationMs) : null,
    details: details === undefined ? null : redact(details),
  };
}

// Keeps the failed entry in memory (last 500) and prints one line to stdout.
function keepInRing(row, err) {
  const message = scrubText(redact(String(err?.message || err)));
  fallbackRing.push({ ...row, ts: new Date().toISOString(), db_error: message });
  while (fallbackRing.length > RING_SIZE) fallbackRing.shift();
  try {
    console.log(JSON.stringify({ level: "error", step: "system-log.db_write_failed", event: row.event, message }));
  } catch {
    // stdout must never break a request
  }
  return false;
}

// Fire-and-forget. Returns a promise that always resolves to true (stored) or false (kept in fallbackRing).
// It never throws, so callers can ignore the result.
// Event rows written during a request wait for the response, so they can carry its real status code.
// Each request store has a "held" list; releaseHeld() fills in the status and writes the rows.
export function releaseHeld(store, statusCode) {
  if (!store?.held) return;
  const held = store.held.splice(0);
  for (const { row, resolve } of held) {
    if (row.status_code === null && Number.isInteger(statusCode)) row.status_code = statusCode;
    enqueue(row).then(resolve);
  }
}

export function logEvent(fields) {
  let row;
  try {
    row = buildRow(fields || {});
  } catch (e) {
    try {
      console.log(JSON.stringify({ level: "error", step: "system-log.build_failed", message: String(e?.message || e) }));
    } catch {
      // ignore
    }
    return Promise.resolve(false);
  }
  const store = requestContext.getStore();
  if (store?.held && row.status_code === null) {
    return new Promise((resolve) => store.held.push({ row, resolve }));
  }
  return enqueue(row);
}

// Batching: rows are queued and written with one multi-row INSERT every 200 ms or every 100 rows.
// This keeps the request path from taking one pool connection per log line (under bursts that
// starved /health). Each caller still gets its own promise, resolved when its batch is stored.
const BATCH_MAX = 100;
const BATCH_DELAY_MS = 200;
let queue = [];
let flushTimer = null;

function enqueue(row) {
  return new Promise((resolve) => {
    queue.push({ row, resolve });
    if (queue.length >= BATCH_MAX) {
      flushNow();
    } else if (!flushTimer) {
      flushTimer = setTimeout(flushNow, BATCH_DELAY_MS);
      flushTimer.unref?.();
    }
  });
}

function flushNow() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  const batch = queue.splice(0, BATCH_MAX);
  if (queue.length && !flushTimer) flushTimer = setTimeout(flushNow, 0);
  if (!batch.length) return;
  const params = [];
  const values = batch.map(({ row }, i) => {
    const o = i * 9;
    params.push(row.category, row.event, row.outcome, row.status_code, row.message, row.masked_identifier,
      row.request_id, row.duration_ms, row.details === null ? null : JSON.stringify(row.details));
    return "($" + [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => o + n).join(",$") + ")";
  });
  let pending;
  try {
    pending = query(
      "INSERT INTO public.system_logs (category, event, outcome, status_code, message, masked_identifier, request_id, duration_ms, details) VALUES " +
        values.join(","),
      params
    );
  } catch (e) {
    pending = Promise.reject(e);
  }
  pending.then(
    () => batch.forEach(({ resolve }) => resolve(true)),
    (e) => batch.forEach(({ row, resolve }) => resolve(keepInRing(row, e)))
  );
}

// Test seam: writes everything queued now, without waiting for the timer.
export function flushSystemLogs() {
  return new Promise((resolve) => {
    flushNow();
    setImmediate(resolve);
  });
}

// Convenience for route handlers: fills requestId from the request.
export function logFromReq(req, fields) {
  return logEvent({ requestId: req?.requestId ?? currentRequestId(), ...fields });
}

// Called from the log.* helper: stores the step only when it is mapped in STEP_EVENTS.
export function logStep(level, step, fields) {
  const ev = classifyStep(step);
  if (!ev) return;
  const f = fields || {};
  // Phone OTPs carry channel "whatsapp" or "sms"; WhatsApp gets its own category.
  const category = ev.category === "otp.sms" && f.channel === "whatsapp" ? "otp.whatsapp" : ev.category;
  logEvent({
    ...ev,
    category,
    statusCode: Number.isInteger(f.status) ? f.status : undefined,
    message: f.reason || EVENT_TEXT[ev.event] || f.error?.message || ev.event,
    identifier: f.email ?? f.phone ?? f.phone_number,
    requestId: currentRequestId(),
    details: {
      step,
      channel: f.channel,
      purpose: f.purpose,
      user_id: f.user_id,
      otp_id: f.otp_id,
      attempts: f.attempts,
      provider_message_id: f.provider_message_id ?? f.message_id,
      level,
    },
  });
}
