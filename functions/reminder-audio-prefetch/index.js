// Port of supabase/functions/reminder-audio-prefetch. Pre-generates audio for timetable call reminders.
//
// Cron mode:  Authorization: Bearer <REMINDER_CRON_KEY>, body { "mode": "cron" }
//   Finds timetable call reminders in the next 3 days without ready audio, generates it, then sends
//   one push per user (see _shared/push.js).
// Plan mode:  Authorization: Bearer <student access token>, body { "timetable_id", "days"? 1|2|3 }
//   Generates audio for that timetable's call reminders in the window. Stops at a 30 second budget.
// Responses carry counts only: no text, keys, tokens or signed URLs.
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";
import { DEFAULT_LANGUAGE, DEFAULT_TTL_SEC, DEFAULT_VOICE, MAX_TTL_SEC, generateForUser } from "../_shared/reminderAudio.js";
import { sendAudioPush } from "../_shared/push.js";
import crypto from "node:crypto";

const DAY_MS = 24 * 60 * 60 * 1000;
const CRON_WINDOW_MS = 3 * DAY_MS;
const CRON_TTL_SEC = MAX_TTL_SEC;
const CRON_BATCH_LIMIT = 200;
const CRON_BUDGET_MS = 100_000;
const PLAN_BUDGET_MS = 30_000;
const PLAN_LIMIT = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invalid = (res, field, message) => res.status(400).json({ error: "invalid_input", field, message });

// Resolves to the value, or null if the deadline passes first.
function withDeadline(p, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), Math.max(1, ms));
    p.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(null); });
  });
}

// Generates audio for one reminder row. Returns null on any failure.
async function prepareRow(row, ttlSec, timeoutMs) {
  const res = await withDeadline(
    generateForUser(row.user_id, row.message_text ?? "", row.voice || DEFAULT_VOICE, row.language || DEFAULT_LANGUAGE, row.id, ttlSec),
    timeoutMs
  );
  if (!res || !res.ok) return null;
  return { rid: row.id, hash: res.hash, url: res.signedUrl, fmt: res.format, fireAt: row.scheduled_at, userId: row.user_id };
}

const ROW_COLUMNS = "id, user_id, message_text, voice, language, scheduled_at, audio_status";

async function runCron(res) {
  const started = Date.now();
  const now = Date.now();
  const { rows } = await query(
    `SELECT ${ROW_COLUMNS} FROM public.reminders
      WHERE kind = 'call' AND source = 'timetable' AND enabled = true AND status = 'scheduled'
        AND audio_status IS DISTINCT FROM 'ready'
        AND scheduled_at >= $1 AND scheduled_at <= $2
      ORDER BY scheduled_at ASC LIMIT $3`,
    [new Date(now), new Date(now + CRON_WINDOW_MS), CRON_BATCH_LIMIT]
  );

  let ready = 0;
  let failed = 0;
  let deferred = 0;
  const byUser = new Map();
  for (const row of rows) {
    const remaining = CRON_BUDGET_MS - (Date.now() - started);
    if (remaining <= 0) {
      deferred++;
      continue;
    }
    const item = await prepareRow(row, CRON_TTL_SEC, remaining);
    if (!item) {
      failed++;
      continue;
    }
    ready++;
    byUser.set(item.userId, [...(byUser.get(item.userId) ?? []), item]);
  }

  let usersPushed = 0;
  let usersPushFailed = 0;
  for (const [userId, items] of byUser) {
    const pushed = await sendAudioPush(userId, items);
    if (pushed.ok) usersPushed++;
    else usersPushFailed++;
  }

  console.log(JSON.stringify({ fn: "reminder-audio-prefetch", mode: "cron", scanned: rows.length, ready, failed, deferred }));
  return res.json({ mode: "cron", scanned: rows.length, ready, failed, deferred, usersPushed, usersPushFailed });
}

async function runPlan(res, userId, timetableId, days) {
  const started = Date.now();
  // Ownership: the timetable must belong to the caller. Other timetables look like not found.
  const { rows: tt } = await query("SELECT id, student_id FROM public.study_timetables WHERE id = $1", [timetableId]);
  if (!tt[0] || tt[0].student_id !== userId) return res.status(404).json({ error: "not_found" });

  const now = Date.now();
  const windowEnd = new Date(now + days * DAY_MS);
  const nowDate = new Date(now);

  const { rows: sessions } = await query(
    "SELECT id FROM public.study_timetable_sessions WHERE timetable_id = $1 AND scheduled_at >= $2 AND scheduled_at <= $3 LIMIT 1000",
    [timetableId, nowDate, windowEnd]
  );
  if (sessions.length === 0) return res.json({ ready: 0, failed: 0 });

  const { rows } = await query(
    `SELECT ${ROW_COLUMNS} FROM public.reminders
      WHERE user_id = $1 AND kind = 'call' AND source = 'timetable' AND enabled = true AND status = 'scheduled'
        AND session_id = ANY($2::uuid[]) AND scheduled_at >= $3 AND scheduled_at <= $4
      ORDER BY scheduled_at ASC LIMIT $5`,
    [userId, sessions.map((s) => s.id), nowDate, windowEnd, PLAN_LIMIT]
  );

  let ready = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.audio_status === "ready") {
      ready++;
      continue;
    }
    const remaining = PLAN_BUDGET_MS - (Date.now() - started);
    if (remaining <= 0) {
      failed++;
      continue;
    }
    const item = await prepareRow(row, DEFAULT_TTL_SEC, remaining);
    if (item) ready++;
    else failed++;
  }
  console.log(JSON.stringify({ fn: "reminder-audio-prefetch", mode: "plan", days, ready, failed }));
  return res.json({ ready, failed });
}

export const router = express.Router();

router.post("/", async (req, res) => {
  if (process.env.CALL_REMINDERS_ENABLED === "false") return res.status(503).json({ error: "disabled" });
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid(res, "body", "Request body must be an object");

  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ error: "unauthorized" });

  // Cron mode: the REMINDER_CRON_KEY secret only.
  if (body.mode === "cron") {
    const cronKey = process.env.REMINDER_CRON_KEY ?? "";
    const ok = cronKey && token.length === cronKey.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(cronKey));
    if (!ok) return res.status(401).json({ error: "unauthorized" });
    return runCron(res);
  }

  // Plan mode: the student's own access token.
  let userId;
  try {
    userId = jwt.verify(token, process.env.JWT_SECRET).sub;
  } catch {
    return res.status(401).json({ error: "unauthorized" });
  }
  const timetableId = body.timetable_id;
  if (typeof timetableId !== "string" || !UUID_RE.test(timetableId)) return invalid(res, "timetable_id", "timetable_id must be a uuid");

  let days = 1;
  if (body.days !== undefined && body.days !== null) {
    if (typeof body.days !== "number" || !Number.isInteger(body.days) || body.days < 1 || body.days > 3) {
      return invalid(res, "days", "days must be 1, 2 or 3");
    }
    days = body.days;
  }
  return runPlan(res, userId, timetableId, days);
});
