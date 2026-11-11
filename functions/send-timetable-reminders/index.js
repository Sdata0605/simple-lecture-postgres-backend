// Port of supabase/functions/send-timetable-reminders. Cron job, run every minute. Two paths:
//  1. Legacy: sessions with no reminder_channel get a 15-minute "starts soon" email.
//  2. Channel 'email' (only when TIMETABLE_REMINDERS_ENABLED=true): sessions due now get a text email
//     with an /open link. Each send is claimed first, so only one run sends it; a failed send releases
//     the claim so the next minute retries (until the session is 10 minutes late).
// GET or POST with Authorization: Bearer <TIMETABLE_REMINDER_CRON_KEY or SERVICE_ROLE_KEY>.
// Mail goes through _shared/mail.js (MAIL_MODE=dry-run records only).
import express from "express";
import crypto from "node:crypto";
import { query } from "../_shared/db.js";
import { sendMail } from "../_shared/mail.js";

export const router = express.Router();

const APP_BASE = "https://simplelecture.com";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function bearerMatches(req, expected) {
  const given = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function assertSmtpIfLive() {
  if (process.env.MAIL_MODE === "smtp" && (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS)) {
    throw new Error("SMTP not configured");
  }
}

// Legacy 15-minute email. Returns { processed, sent }.
async function sendLegacyReminders() {
  const nowMs = Date.now();
  const { rows: sessions } = await query(
    `SELECT id, student_id, course_id, subject_id, title, scheduled_at, duration_minutes
       FROM public.study_timetable_sessions
      WHERE reminder_sent_at IS NULL AND reminder_channel IS NULL AND status = 'pending'
        AND scheduled_at >= $1 AND scheduled_at <= $2`,
    [new Date(nowMs + 14 * 60 * 1000), new Date(nowMs + 16 * 60 * 1000)]
  );
  if (sessions.length === 0) return { processed: 0, sent: 0 };

  assertSmtpIfLive();

  let sent = 0;
  for (const s of sessions) {
    const { rows: pr } = await query("SELECT email, full_name FROM public.profiles WHERE id = $1", [s.student_id]);
    const profile = pr[0];
    if (!profile?.email) continue;
    const { rows: cr } = await query("SELECT name FROM public.courses WHERE id = $1", [s.course_id]);
    const course = cr[0];
    const { rows: sr } = s.subject_id ? await query("SELECT name FROM public.popular_subjects WHERE id = $1", [s.subject_id]) : { rows: [] };
    const subject = sr[0];
    const startTime = new Date(s.scheduled_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });

    try {
      await sendMail({
        to: profile.email,
        subject: `⏰ Study reminder: ${s.title} starts in 15 minutes`,
        html: `
          <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;">
            <div style="background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);padding:32px 24px;text-align:center;border-radius:0 0 24px 24px;">
              <h1 style="color:#fff;margin:0;font-size:26px;">⏰ Time to Study!</h1>
              <p style="color:rgba(255,255,255,0.9);margin:8px 0 0;font-size:15px;">Your scheduled session starts in 15 minutes</p>
            </div>
            <div style="padding:32px 24px;">
              <p style="color:#374151;font-size:17px;margin:0 0 16px;">Hi ${escapeHtml(profile.full_name || "Student")},</p>
              <p style="color:#4b5563;font-size:15px;line-height:1.6;margin:0 0 20px;">
                This is a friendly reminder for your study session:
              </p>
              <div style="background:#f8f7ff;border-left:4px solid #6366f1;border-radius:8px;padding:20px;margin:20px 0;">
                <p style="margin:0 0 8px;color:#1f2937;font-size:18px;font-weight:600;">${escapeHtml(s.title)}</p>
                ${course ? `<p style="margin:4px 0;color:#6b7280;font-size:14px;">📘 ${escapeHtml(course.name)}</p>` : ""}
                ${subject ? `<p style="margin:4px 0;color:#6b7280;font-size:14px;">📚 ${escapeHtml(subject.name)}</p>` : ""}
                <p style="margin:4px 0;color:#6b7280;font-size:14px;">🕒 ${startTime} · ${s.duration_minutes} min</p>
              </div>
              <div style="text-align:center;margin:28px 0;">
                <a href="${APP_BASE}/timetable" style="display:inline-block;background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:16px;font-weight:600;">Open My Time Table →</a>
              </div>
              <p style="color:#9ca3af;font-size:13px;text-align:center;margin:24px 0 0;">You're doing great. Consistency wins. 💪</p>
            </div>
          </div>`,
      });
      await query("UPDATE public.study_timetable_sessions SET reminder_sent_at = now() WHERE id = $1", [s.id]);
      sent++;
    } catch (e) {
      console.error("[timetable-reminder] send failed", s.id, e?.message);
    }
  }
  return { processed: sessions.length, sent };
}

// Channel 'email' reminders. Returns { due, sent }.
async function sendChannelEmails() {
  if (process.env.TIMETABLE_REMINDERS_ENABLED !== "true") return { due: 0, sent: 0 };

  const nowMs = Date.now();
  const { rows: sessions } = await query(
    `SELECT id, student_id, course_id, subject_id, chapter_id, topic_id, title, scheduled_at, duration_minutes
       FROM public.study_timetable_sessions
      WHERE reminder_channel = 'email' AND status = 'pending' AND reminder_sent_at IS NULL
        AND scheduled_at >= $1 AND scheduled_at <= $2`,
    [new Date(nowMs - 10 * 60 * 1000), new Date(nowMs + 1 * 60 * 1000)]
  );
  if (sessions.length === 0) return { due: 0, sent: 0 };

  assertSmtpIfLive();

  let sent = 0;
  for (const s of sessions) {
    const { rows: pr } = await query("SELECT email, full_name FROM public.profiles WHERE id = $1", [s.student_id]);
    const profile = pr[0];
    if (!profile?.email) continue;

    // Claim: only the run that flips reminder_sent_at from null sends.
    const { rows: claimed } = await query(
      "UPDATE public.study_timetable_sessions SET reminder_sent_at = now() WHERE id = $1 AND reminder_sent_at IS NULL RETURNING id",
      [s.id]
    );
    if (claimed.length === 0) continue;

    const topic = String(s.title || "your next topic").replace(/\s+/g, " ").trim().slice(0, 120);
    let openPath = "/timetable";
    if (isUuid(s.topic_id) && isUuid(s.course_id)) {
      const q = new URLSearchParams({ courseId: s.course_id });
      if (isUuid(s.subject_id)) q.set("subjectId", s.subject_id);
      if (isUuid(s.chapter_id)) q.set("chapterId", s.chapter_id);
      openPath = `/open/topic/${s.topic_id}?${q.toString()}`;
    } else if (isUuid(s.chapter_id) && isUuid(s.course_id)) {
      const q = new URLSearchParams({ courseId: s.course_id });
      if (isUuid(s.subject_id)) q.set("subjectId", s.subject_id);
      openPath = `/open/chapter/${s.chapter_id}?${q.toString()}`;
    }
    const openUrl = `${APP_BASE}${openPath}`;
    const safeTopic = escapeHtml(topic);
    const safeName = escapeHtml(profile.full_name || "Student");

    try {
      await sendMail({
        to: profile.email,
        subject: `Time to study ${topic}`,
        text: `Hey, it's time to study ${topic}. Tap to open the app.\n\n${openUrl}`,
        html: `
          <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;">
            <div style="background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);padding:32px 24px;text-align:center;border-radius:0 0 24px 24px;">
              <h1 style="color:#fff;margin:0;font-size:26px;">Time to Study!</h1>
            </div>
            <div style="padding:32px 24px;">
              <p style="color:#374151;font-size:17px;margin:0 0 16px;">Hi ${safeName},</p>
              <p style="color:#1f2937;font-size:17px;line-height:1.6;margin:0 0 20px;">
                Hey, it's time to study <strong>${safeTopic}</strong>. Tap to open the app.
              </p>
              <div style="text-align:center;margin:28px 0;">
                <a href="${escapeHtml(openUrl)}" style="display:inline-block;background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:16px;font-weight:600;">Open in app</a>
              </div>
            </div>
          </div>`,
      });
      sent++;
    } catch (e) {
      console.error("[timetable-reminder] channel email failed", s.id, e?.message);
      // Release the claim so the next minute retries (until 10 minutes late).
      await query("UPDATE public.study_timetable_sessions SET reminder_sent_at = NULL WHERE id = $1", [s.id]);
    }
  }
  return { due: sessions.length, sent };
}

router.all("/", async (req, res) => {
  try {
    if (!bearerMatches(req, process.env.TIMETABLE_REMINDER_CRON_KEY) && !bearerMatches(req, process.env.SERVICE_ROLE_KEY)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const legacy = await sendLegacyReminders();
    const channel = await sendChannelEmails();
    return res.json({ processed: legacy.processed, sent: legacy.sent, channelEmails: channel });
  } catch (err) {
    console.error("[send-timetable-reminders]", err?.message);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
