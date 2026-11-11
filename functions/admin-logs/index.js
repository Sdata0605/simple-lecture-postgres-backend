// Admin log API, mounted at /admin/api (see src/app.js).
// Login uses ADMIN_LOG_KEY (fails closed when unset). Sessions are in memory: a restart signs everyone out.
// Every route except login and logout needs a valid sl_admin session cookie.
import express from "express";
import crypto from "node:crypto";
import { query } from "../_shared/db.js";
import { CATEGORIES, OUTCOMES, logEvent, redact } from "../_shared/system-log.js";
import { getProviderStatus } from "../_shared/provider-status.js";

export const router = express.Router();

const COOKIE = "sl_admin";
const SESSION_MS = 8 * 60 * 60 * 1000;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_LIMIT = 5;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const EXPORT_MAX = 10000;
const MAX_BUCKETS = 5000;
const MAX_Q = 100;
const BUCKET_SECONDS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "1d": 86400 };
const STATUS_RANGES = { "2xx": [200, 299], "4xx": [400, 499], "5xx": [500, 599] };
const DAY_MS = 24 * 60 * 60 * 1000;

const sessions = new Map(); // token -> expiresAt (ms)
const failures = new Map(); // ip -> [timestamps of failed logins]

// For tests only: lets them age sessions and login failures instead of waiting hours or minutes.
export const _testHooks = { sessions, failures };

class HttpError extends Error {
  constructor(status, error) {
    super(error);
    this.status = status;
    this.error = error;
  }
}

router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// ---- cookies and sessions

function readCookie(header, name) {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

function cookieHeader(value, maxAgeSec) {
  const parts = [`${COOKIE}=${value}`, "Path=/admin", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSec}`];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

function pruneSessions(now) {
  for (const [token, expiresAt] of sessions) if (expiresAt <= now) sessions.delete(token);
}

function recentFailures(ip, now) {
  const list = (failures.get(ip) || []).filter((t) => now - t < FAIL_WINDOW_MS);
  if (list.length) failures.set(ip, list);
  else failures.delete(ip);
  return list;
}

// Both sides are hashed first so the buffers always have the same length.
function keyMatches(given) {
  const expected = process.env.ADMIN_LOG_KEY || "";
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function logLogin(req, outcome, statusCode, message) {
  logEvent({
    category: "admin",
    event: outcome === "success" ? "login.success" : "login.failed",
    outcome,
    statusCode,
    message,
    requestId: req.requestId,
  });
}

// ---- login and logout (not behind requireAdmin)

router.post("/login", (req, res) => {
  const now = Date.now();
  const ip = req.ip || req.socket?.remoteAddress || "unknown";

  if (!process.env.ADMIN_LOG_KEY) {
    logLogin(req, "failed", 503, "Admin login unavailable: admin key is not set on the server");
    return res.status(503).json({ error: "not_configured" });
  }
  if (recentFailures(ip, now).length >= FAIL_LIMIT) {
    logLogin(req, "failed", 429, "Admin login blocked: too many wrong attempts, wait 10 minutes");
    return res.status(429).json({ error: "too_many_attempts" });
  }

  const given = req.body?.key;
  const ok = typeof given === "string" && keyMatches(given);
  if (!ok) {
    failures.set(ip, [...recentFailures(ip, now), now]);
    logLogin(req, "failed", 401, "Admin login failed: wrong admin key");
    return res.status(401).json({ error: "invalid_key" });
  }

  pruneSessions(now);
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, now + SESSION_MS);
  res.setHeader("Set-Cookie", cookieHeader(token, SESSION_MS / 1000));
  logLogin(req, "success", 200, "Admin logged in");
  return res.json({ ok: true, expires_at: new Date(now + SESSION_MS).toISOString() });
});

router.post("/logout", (req, res) => {
  const token = readCookie(req.headers.cookie, COOKIE);
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", cookieHeader("", 0));
  return res.json({ ok: true });
});

// ---- everything below requires a session

function requireAdmin(req, res, next) {
  const token = readCookie(req.headers.cookie, COOKIE);
  const expiresAt = token ? sessions.get(token) : undefined;
  if (expiresAt === undefined || expiresAt <= Date.now()) {
    if (token) sessions.delete(token);
    return res.status(401).json({ error: "unauthorized" });
  }
  return next();
}

router.use(requireAdmin);

// ---- query parsing

const ISO_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

// Returns a string, undefined when absent or empty, or throws 400 for arrays and other types.
function one(value, name) {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new HttpError(400, `${name}_invalid`);
  return value;
}

// Canonical form: YYYY-MM-DDTHH:MM[:SS[.frac]](Z|+HH:MM). Postgres rejects year 0, days past the
// end of the month and out-of-range offsets, and V8 silently rolls some of those over, so check here.
const CANON_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/;
function isValidTimestamp(s) {
  const m = CANON_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  const dim = new Date(0);
  dim.setUTCFullYear(y, mo, 0); // day 0 of the next month = last day of this month
  if (d > dim.getUTCDate()) return false;
  if (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6] ?? 0) > 59) return false;
  if (m[8] && (Number(m[9]) > 15 || Number(m[10]) > 59)) return false;
  return !Number.isNaN(Date.parse(s));
}

// Times without a zone are read as UTC.
function parseTime(value, name) {
  const v = one(value, name);
  if (v === undefined) return undefined;
  if (!ISO_RE.test(v)) throw new HttpError(400, `${name}_invalid`);
  let s = v;
  if (!s.includes("T")) s += "T00:00:00Z";
  else if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += "Z";
  s = s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"); // +0530 -> +05:30
  if (!isValidTimestamp(s)) throw new HttpError(400, `${name}_invalid`);
  return new Date(s);
}

function parseLimit(value) {
  const v = one(value, "limit");
  if (v === undefined) return DEFAULT_LIMIT;
  if (!/^\d+$/.test(v) || Number(v) < 1) throw new HttpError(400, "limit_invalid");
  return Math.min(Number(v), MAX_LIMIT);
}

function parseCursor(value) {
  const v = one(value, "cursor");
  if (v === undefined) return undefined;
  const raw = Buffer.from(v, "base64").toString("utf8");
  const i = raw.lastIndexOf("|");
  const ts = raw.slice(0, Math.max(i, 0));
  const id = raw.slice(i + 1);
  // ts is the Postgres text form of timestamptz, which keeps microseconds.
  if (i <= 0 || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:?\d{2})?$/.test(ts) || !/^\d{1,18}$/.test(id)) {
    throw new HttpError(400, "cursor_invalid");
  }
  const canon = ts.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  if (!isValidTimestamp(canon)) throw new HttpError(400, "cursor_invalid");
  return { ts, id };
}

// Shared filters for list, export and summary.
function parseFilters(q, { withCursor = false } = {}) {
  const from = parseTime(q.from, "from") ?? new Date(Date.now() - DAY_MS);
  const to = parseTime(q.to, "to");
  if (to && to < from) throw new HttpError(400, "window_invalid");

  const category = one(q.category, "category");
  if (category !== undefined && !CATEGORIES.includes(category)) throw new HttpError(400, "category_invalid");
  const outcome = one(q.outcome, "outcome");
  if (outcome !== undefined && !OUTCOMES.includes(outcome)) throw new HttpError(400, "outcome_invalid");

  const statusClass = one(q.status_class, "status_class");
  if (statusClass !== undefined && !STATUS_RANGES[statusClass]) throw new HttpError(400, "status_class_invalid");

  const text = one(q.q, "q");
  if (text !== undefined && text.length > MAX_Q) throw new HttpError(400, "q_too_long");
  // Postgres text cannot hold NUL bytes; they would otherwise surface as a 500.
  if (text !== undefined && text.includes("\u0000")) throw new HttpError(400, "q_invalid");

  // Event name prefix, for example login. or signup.; lets the UI filter without fetching whole categories.
  const eventPrefix = one(q.event_prefix, "event_prefix");
  if (eventPrefix !== undefined && !/^[a-z_.]{1,40}$/.test(eventPrefix)) throw new HttpError(400, "event_prefix_invalid");

  const errors = one(q.errors_only, "errors_only");
  if (errors !== undefined && errors !== "true" && errors !== "false") throw new HttpError(400, "errors_only_invalid");

  return {
    from,
    to,
    category,
    outcome,
    statusRange: statusClass ? STATUS_RANGES[statusClass] : undefined,
    q: text,
    errorsOnly: errors === "true",
    eventPrefix,
    cursor: withCursor ? parseCursor(q.cursor) : undefined,
  };
}

// Builds a parameterised WHERE clause. Parameters are never interpolated.
function buildWhere(f) {
  const where = [];
  const params = [];
  const p = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  where.push(`ts >= ${p(f.from.toISOString())}::timestamptz`);
  if (f.to) where.push(`ts <= ${p(f.to.toISOString())}::timestamptz`);
  if (f.category) where.push(`category = ${p(f.category)}`);
  if (f.outcome) where.push(`outcome = ${p(f.outcome)}`);
  if (f.eventPrefix) where.push(`event LIKE ${p(f.eventPrefix.replace(/[\\%_]/g, "\\$&") + "%")}`);
  if (f.statusRange) where.push(`status_code BETWEEN ${p(f.statusRange[0])} AND ${p(f.statusRange[1])}`);
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, "\\$&")}%`;
    const ph = p(like);
    where.push(`(masked_identifier ILIKE ${ph} OR request_id ILIKE ${ph} OR message ILIKE ${ph})`);
  }
  if (f.errorsOnly) where.push("(outcome = 'failed' OR status_code >= 400)");
  if (f.cursor) {
    const ts = p(f.cursor.ts);
    const id = p(f.cursor.id);
    where.push(`(ts < ${ts}::timestamptz OR (ts = ${ts}::timestamptz AND id < ${id}::bigint))`);
  }
  return { where: where.join(" AND "), params };
}

// ---- row shaping

const iso = (d) => (d ? new Date(d).toISOString() : null);

function toItem(r, withDetails) {
  const item = {
    id: Number(r.id),
    ts: iso(r.ts),
    category: r.category,
    event: r.event,
    outcome: r.outcome,
    status_code: r.status_code,
    message: redact(r.message),
    masked_identifier: r.masked_identifier,
    request_id: r.request_id,
    duration_ms: r.duration_ms,
  };
  if (withDetails) item.details = redact(r.details);
  return item;
}

const LIST_COLUMNS = `id, ts::text AS ts_text, ts, category, event, outcome, status_code, message,
  masked_identifier, request_id, duration_ms`;

// ---- routes

router.get("/logs", async (req, res) => {
  const f = parseFilters(req.query, { withCursor: true });
  const limit = parseLimit(req.query.limit);
  const { where, params } = buildWhere(f);
  params.push(limit);
  const { rows } = await query(
    `SELECT ${LIST_COLUMNS} FROM public.system_logs
      WHERE ${where}
      ORDER BY ts DESC, id DESC
      LIMIT $${params.length}`,
    params
  );
  const last = rows[rows.length - 1];
  const next_cursor =
    rows.length === limit && last ? Buffer.from(`${last.ts_text}|${last.id}`, "utf8").toString("base64") : null;
  return res.json({ items: rows.map((r) => toItem(r, false)), next_cursor });
});

router.get("/logs/export", async (req, res) => {
  const format = one(req.query.format, "format") ?? "json";
  if (format !== "csv" && format !== "json") throw new HttpError(400, "format_invalid");
  const f = parseFilters(req.query);
  const { where, params } = buildWhere(f);
  params.push(EXPORT_MAX + 1);
  const { rows } = await query(
    `SELECT id, ts, category, event, outcome, status_code, message, masked_identifier,
            request_id, duration_ms, details
       FROM public.system_logs
      WHERE ${where}
      ORDER BY ts DESC, id DESC
      LIMIT $${params.length}`,
    params
  );
  const truncated = rows.length > EXPORT_MAX;
  const items = rows.slice(0, EXPORT_MAX).map((r) => toItem(r, true));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  res.setHeader("X-Export-Truncated", String(truncated));

  if (format === "json") {
    res.setHeader("Content-Disposition", `attachment; filename="admin-logs-${stamp}.json"`);
    return res.type("application/json; charset=utf-8").send(JSON.stringify(items));
  }

  res.setHeader("Content-Disposition", `attachment; filename="admin-logs-${stamp}.csv"`);
  const columns = ["id", "ts", "category", "event", "outcome", "status_code", "message",
    "masked_identifier", "request_id", "duration_ms", "details"];
  const lines = [columns.join(",")];
  for (const item of items) lines.push(columns.map((c) => csvCell(item[c])).join(","));
  return res.type("text/csv; charset=utf-8").send(lines.join("\r\n") + "\r\n");
});

// Quotes every field. Cells starting with = + - @ (or tab / CR) get a leading apostrophe so
// spreadsheets do not run them as formulas.
export function csvCell(value) {
  let s = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/^\s*[=+\-@]|^[\t\r\n]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

router.get("/logs/summary", async (req, res) => {
  const bucket = one(req.query.bucket, "bucket") ?? "15m";
  if (!BUCKET_SECONDS[bucket]) throw new HttpError(400, "bucket_invalid");
  const secs = BUCKET_SECONDS[bucket];
  const from = parseTime(req.query.from, "from") ?? new Date(Date.now() - DAY_MS);
  const to = parseTime(req.query.to, "to") ?? new Date();
  if (to < from) throw new HttpError(400, "window_invalid");
  if ((to - from) / 1000 / secs > MAX_BUCKETS) throw new HttpError(400, "window_too_large");

  const { where, params } = buildWhere({ from, to });
  const failedExpr = "(outcome = 'failed' OR status_code >= 400)";

  const bucketRows = await query(
    `SELECT (floor(extract(epoch FROM ts) / $${params.length + 1}::numeric) * $${params.length + 1}::numeric)::bigint AS bucket_epoch,
            category, ${failedExpr} AS failed, count(*)::int AS n
       FROM public.system_logs
      WHERE ${where}
      GROUP BY 1, 2, 3
      ORDER BY 1`,
    [...params, secs]
  );

  const errorRows = await query(
    `SELECT message, category, count(*)::int AS count
       FROM public.system_logs
      WHERE ${where} AND ${failedExpr}
      GROUP BY message, category
      ORDER BY count DESC, message
      LIMIT 10`,
    params
  );

  const buckets = new Map();
  const cats = new Map();
  for (const r of bucketRows.rows) {
    const start = new Date(Number(r.bucket_epoch) * 1000).toISOString();
    if (!buckets.has(start)) buckets.set(start, { start, total: 0, failed: 0, by_category: {} });
    const b = buckets.get(start);
    b.total += r.n;
    if (r.failed) b.failed += r.n;
    b.by_category[r.category] = (b.by_category[r.category] || 0) + r.n;

    const c = cats.get(r.category) || { category: r.category, total: 0, failed: 0 };
    c.total += r.n;
    if (r.failed) c.failed += r.n;
    cats.set(r.category, c);
  }

  const by_category = [...cats.values()]
    .map((c) => ({ category: c.category, total: c.total, failed: c.failed, failure_rate: c.total ? Number((c.failed / c.total).toFixed(4)) : 0 }))
    .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category));

  return res.json({
    from: from.toISOString(),
    to: to.toISOString(),
    bucket,
    buckets: [...buckets.values()],
    by_category,
    top_errors: errorRows.rows.map((r) => ({ message: redact(r.message), category: r.category, count: r.count })),
  });
});

router.get("/logs/:id", async (req, res) => {
  if (!/^\d{1,18}$/.test(req.params.id)) throw new HttpError(400, "id_invalid");
  const { rows } = await query(
    `SELECT id, ts, category, event, outcome, status_code, message, masked_identifier,
            request_id, duration_ms, details
       FROM public.system_logs WHERE id = $1`,
    [req.params.id]
  );
  if (!rows[0]) throw new HttpError(404, "not_found");
  return res.json(toItem(rows[0], true));
});

router.get("/providers/status", async (req, res) => {
  return res.json(await getProviderStatus());
});

// Errors from the routes above. Never echoes internal messages.
router.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.error });
  console.error(JSON.stringify({ level: "error", step: "admin-logs.failed", message: err?.message }));
  return res.status(500).json({ error: "internal_error" });
});
