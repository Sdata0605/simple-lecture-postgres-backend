// Port of supabase/functions/reminder-prepare-next-day. Prepares tomorrow's call-reminder audio for
// one student, once today's last call is over. No clock time anywhere:
//   1. The app, after a call ends: POST with the user's access token. Only that user is prepared.
//   2. A scheduled job: POST with header x-cron-key = REMINDER_PREP_CRON_KEY. Body { userId } prepares
//      one user; an empty body sweeps users with call reminders in the current window.
// Rule: prepare only when every call reminder of the user's local today is finished, then generate
// audio for the user's local tomorrow call reminders only.
import crypto from "node:crypto";
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";
import { ensureCallAudio } from "../_shared/reminderCallAudio.js";

const DEFAULT_TZ = "Asia/Kolkata";
const RING_WINDOW_MS = 5 * 60 * 1000;
const MAX_CLIPS_PER_RUN = 10;
const MAX_USERS_PER_SWEEP = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeTz(tz) {
  const candidate = (tz ?? "").trim() || DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: candidate });
    return candidate;
  } catch {
    return DEFAULT_TZ;
  }
}

// Local calendar date (YYYY-MM-DD) of an instant in the given IANA zone.
const localDate = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

async function prepareUser(userId, now) {
  const from = new Date(now.getTime() - DAY_MS);
  const to = new Date(now.getTime() + 2 * DAY_MS);
  const { rows } = await query(
    `SELECT id, user_id, message_text, voice, language, scheduled_at, status, enabled, tz FROM public.reminders
      WHERE user_id = $1 AND kind = 'call' AND enabled = true AND status <> 'cancelled'
        AND scheduled_at >= $2 AND scheduled_at <= $3`,
    [userId, from, to]
  );

  const tz = safeTz(rows[0]?.tz);
  const today = localDate(now, tz);
  const tomorrow = localDate(new Date(now.getTime() + DAY_MS), tz);

  const todays = rows.filter((r) => localDate(new Date(r.scheduled_at), tz) === today);
  if (todays.length === 0) return { prepared: false, reason: "no_calls_today" };

  const stillOpen = todays.filter((r) => r.status === "scheduled" && new Date(r.scheduled_at).getTime() + RING_WINDOW_MS > now.getTime());
  if (stillOpen.length > 0) return { prepared: false, reason: "calls_still_open", open: stillOpen.length };

  const tomorrows = rows
    .filter((r) => r.status === "scheduled" && localDate(new Date(r.scheduled_at), tz) === tomorrow)
    .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at))
    .slice(0, MAX_CLIPS_PER_RUN);
  if (tomorrows.length === 0) return { prepared: false, reason: "no_calls_tomorrow" };

  const counts = { generated: 0, cached: 0, quota: 0, failed: 0, not_configured: 0 };
  for (const r of tomorrows) {
    const res = await ensureCallAudio({ userId, reminderId: r.id, text: r.message_text ?? "", voice: r.voice, language: r.language });
    counts[res.status] = (counts[res.status] ?? 0) + 1;
  }
  console.log(JSON.stringify({ fn: "reminder-prepare-next-day", day: tomorrow, counts }));
  return { prepared: true, day: tomorrow, counts };
}

function constantTimeEquals(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export const router = express.Router();

router.post("/", async (req, res) => {
  if (process.env.CALL_REMINDERS_ENABLED === "false") return res.status(503).json({ error: "disabled" });
  const now = new Date();
  const presentedKey = String(req.headers["x-cron-key"] || "");

  // Scheduled job path
  if (presentedKey) {
    const cronKey = process.env.REMINDER_PREP_CRON_KEY ?? "";
    if (!cronKey || !constantTimeEquals(presentedKey, cronKey)) return res.status(401).json({ error: "unauthorized" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (typeof body.userId === "string") {
      if (!UUID_RE.test(body.userId)) return res.status(400).json({ error: "invalid_input", field: "userId" });
      return res.json({ mode: "cron_user", ...(await prepareUser(body.userId, now)) });
    }

    const { rows } = await query(
      `SELECT DISTINCT user_id FROM public.reminders
        WHERE kind = 'call' AND enabled = true AND status = 'scheduled'
          AND scheduled_at >= $1 AND scheduled_at <= $2
        LIMIT 1000`,
      [new Date(now.getTime() - DAY_MS), new Date(now.getTime() + 2 * DAY_MS)]
    );
    const users = rows.map((r) => r.user_id).slice(0, MAX_USERS_PER_SWEEP);
    const summary = {};
    for (const uid of users) {
      const r = await prepareUser(uid, now);
      const key = r.prepared ? "prepared" : String(r.reason);
      summary[key] = (summary[key] ?? 0) + 1;
    }
    return res.json({ mode: "cron_sweep", users: users.length, summary });
  }

  // App path (after a call ends)
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ error: "unauthorized" });
  let userId;
  try {
    userId = jwt.verify(token, process.env.JWT_SECRET).sub;
  } catch {
    return res.status(401).json({ error: "unauthorized" });
  }
  return res.json({ mode: "self", ...(await prepareUser(userId, now)) });
});
