// Daily blog post: the production database runs pg_cron job 'generate-daily-blog-post' at 00:30 every day
// (UTC). The local backend has no pg_cron, so this timer does the same thing: once a day at 00:30 UTC it calls
// POST /functions/v1/generate-blog-post on this server. The route checks the x-service-key header, so the
// key is created in memory at startup (only when SERVICE_KEY is empty) and is never written anywhere.
// Turn it off with BLOG_DAILY_ENABLED=false.
import crypto from "node:crypto";

export const DAILY_HOUR_UTC = 0;
export const DAILY_MINUTE_UTC = 30;

// The next 00:30 UTC strictly after `from`.
export function nextRunAt(from = new Date(), hour = DAILY_HOUR_UTC, minute = DAILY_MINUTE_UTC) {
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hour, minute, 0, 0));
  if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

let timer = null;

export function ensureSelfServiceKey() {
  if (!process.env.SERVICE_KEY) process.env.SERVICE_KEY = crypto.randomBytes(32).toString("hex");
  return process.env.SERVICE_KEY;
}

// One run: calls the route on this server. Returns { ok, status, error }. Never throws.
export async function runDailyBlogOnce({ host, port, fetchImpl = fetch, log = console.log } = {}) {
  const key = ensureSelfServiceKey();
  const url = `http://${host}:${port}/functions/v1/generate-blog-post`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-service-key": key },
      body: JSON.stringify({ scheduled: true }),
      signal: AbortSignal.timeout(180_000),
    });
    const body = await res.text();
    if (res.ok) {
      log(JSON.stringify({ level: "info", step: "blog.daily.created", status: res.status }));
      return { ok: true, status: res.status };
    }
    log(JSON.stringify({ level: "error", step: "blog.daily.failed", status: res.status, detail: body.slice(0, 200) }));
    return { ok: false, status: res.status, error: body.slice(0, 200) };
  } catch (err) {
    log(JSON.stringify({ level: "error", step: "blog.daily.failed", message: String(err?.message || err).slice(0, 200) }));
    return { ok: false, error: String(err?.message || err) };
  }
}

// Starts the daily timer. Calling it again replaces the earlier timer.
export function startDailyBlogSchedule({ host, port, fetchImpl, log, now = () => new Date() } = {}) {
  stopDailyBlogSchedule();
  const schedule = () => {
    const delay = Math.max(1000, nextRunAt(now()).getTime() - now().getTime());
    timer = setTimeout(async () => {
      await runDailyBlogOnce({ host, port, fetchImpl, log });
      schedule();
    }, delay);
    // unref: this timer alone must not keep the process alive.
    timer.unref();
  };
  schedule();
  return timer;
}

export function stopDailyBlogSchedule() {
  if (timer) clearTimeout(timer);
  timer = null;
}
