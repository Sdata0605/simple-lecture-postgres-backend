// Port of supabase/functions/send-test-reminders. Cron job: emails students about scheduled tests
// (study_timetable_sessions with session_type 'test') about 24 hours and 1 hour before they start.
// GET or POST with Authorization: Bearer <TIMETABLE_REMINDER_CRON_KEY or SERVICE_ROLE_KEY>.
// The original had no check; the cron key is added because the job sends email.
// Mail goes through _shared/mail.js (MAIL_MODE=dry-run records only).
import express from "express";
import crypto from "node:crypto";
import { query } from "../_shared/db.js";
import { sendMail } from "../_shared/mail.js";

export const router = express.Router();

const SITE_URL = "https://simplelecture.com";

function bearerMatches(req, expected) {
  const given = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function fmtIST(iso) {
  return (
    new Date(iso).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      weekday: "short", day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: true,
    }) + " IST"
  );
}

function buildHtml({ name, title, whenIST, duration, courseName, subjectName, chapterName, windowLabel }) {
  const meta = [courseName, subjectName, chapterName].filter(Boolean).join(" • ");
  return `
  <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:600px;margin:0 auto;background:#ffffff;">
    <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:32px 28px;border-radius:0 0 20px 20px;text-align:center;">
      <h1 style="color:#fff;margin:0;font-size:24px;">⏰ Test reminder — in ${windowLabel}</h1>
    </div>
    <div style="padding:28px;">
      <p style="font-size:16px;color:#374151;margin:0 0 12px;">Hi ${name},</p>
      <p style="font-size:15px;color:#4b5563;line-height:1.6;margin:0 0 20px;">
        This is a friendly reminder that you scheduled a test on your study timetable.
        It starts in about <strong>${windowLabel}</strong>.
      </p>
      <div style="background:#f8f7ff;border-radius:12px;padding:20px;margin:16px 0;">
        <p style="margin:0 0 8px;font-size:18px;font-weight:600;color:#111827;">${title}</p>
        ${meta ? `<p style="margin:0 0 8px;font-size:13px;color:#6b7280;">${meta}</p>` : ""}
        <p style="margin:0;font-size:14px;color:#374151;"><strong>When:</strong> ${whenIST}</p>
        <p style="margin:4px 0 0;font-size:14px;color:#374151;"><strong>Duration:</strong> ${duration} minutes</p>
      </div>
      <div style="text-align:center;margin:28px 0;">
        <a href="${SITE_URL}/study-timetable" style="display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;">
          Open my Study Timetable
        </a>
      </div>
      <p style="font-size:12px;color:#9ca3af;text-align:center;margin:24px 0 0;">
        You're receiving this because you scheduled a test on your personal SimpleLecture timetable.
      </p>
    </div>
  </div>`;
}

router.all("/", async (req, res) => {
  try {
    if (!bearerMatches(req, process.env.TIMETABLE_REMINDER_CRON_KEY) && !bearerMatches(req, process.env.SERVICE_ROLE_KEY)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const now = Date.now();
    // Anything pending that starts within the next 25 hours and may still need a reminder
    const horizonStart = new Date(now - 5 * 60 * 1000);
    const horizonEnd = new Date(now + 25 * 60 * 60 * 1000);

    const { rows } = await query(
      `SELECT id, student_id, title, scheduled_at, duration_minutes, course_id, subject_id, chapter_id,
              reminder_24h_sent_at, reminder_1h_sent_at
         FROM public.study_timetable_sessions
        WHERE session_type = 'test' AND status = 'pending'
          AND scheduled_at >= $1 AND scheduled_at <= $2`,
      [horizonStart, horizonEnd]
    );

    if (rows.length === 0) return res.json({ checked: 0, sent: 0 });

    if (process.env.MAIL_MODE === "smtp" && (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS)) {
      throw new Error("SMTP not configured");
    }

    // Lookups, cached per call
    const courseCache = new Map();
    const subjectCache = new Map();
    const chapterCache = new Map();
    const userCache = new Map();
    const nameOf = async (cache, sql, id) => {
      if (!id) return undefined;
      if (cache.has(id)) return cache.get(id);
      const { rows: r } = await query(sql, [id]);
      const v = r[0]?.name ?? r[0]?.title ?? "";
      cache.set(id, v);
      return v;
    };
    const getUser = async (id) => {
      if (userCache.has(id)) return userCache.get(id);
      const { rows: u } = await query("SELECT email FROM auth.users WHERE id = $1", [id]);
      const { rows: p } = await query("SELECT full_name FROM public.profiles WHERE id = $1", [id]);
      const v = { email: u[0]?.email || "", name: p[0]?.full_name || "Student" };
      userCache.set(id, v);
      return v;
    };

    let sent = 0;
    for (const r of rows) {
      const diffMin = (new Date(r.scheduled_at).getTime() - now) / 60000;

      // 24h window: 23h 45m to 24h 15m before start
      const need24 = !r.reminder_24h_sent_at && diffMin >= 23 * 60 + 45 && diffMin <= 24 * 60 + 15;
      // 1h window: 45m to 75m before start
      const need1 = !r.reminder_1h_sent_at && diffMin >= 45 && diffMin <= 75;
      if (!need24 && !need1) continue;

      const user = await getUser(r.student_id);
      if (!user.email) continue;

      const courseName = await nameOf(courseCache, "SELECT name FROM public.courses WHERE id = $1", r.course_id);
      const subjectName = await nameOf(subjectCache, "SELECT name FROM public.popular_subjects WHERE id = $1", r.subject_id);
      const chapterName = await nameOf(chapterCache, "SELECT title FROM public.subject_chapters WHERE id = $1", r.chapter_id);

      const windowLabel = need24 ? "24 hours" : "1 hour";
      try {
        await sendMail({
          to: user.email,
          subject: `⏰ Test reminder: ${r.title} — in ${windowLabel}`,
          html: buildHtml({
            name: user.name,
            title: r.title,
            whenIST: fmtIST(r.scheduled_at),
            duration: r.duration_minutes,
            courseName, subjectName, chapterName,
            windowLabel,
          }),
        });

        if (need24) await query("UPDATE public.study_timetable_sessions SET reminder_24h_sent_at = now() WHERE id = $1", [r.id]);
        if (need1) await query("UPDATE public.study_timetable_sessions SET reminder_1h_sent_at = now() WHERE id = $1", [r.id]);
        sent++;
      } catch (e) {
        console.error("[test-reminder] send failed for a session:", e?.message);
      }
    }

    return res.json({ checked: rows.length, sent });
  } catch (e) {
    console.error("[test-reminder] fatal:", e?.message);
    return res.status(500).json({ error: e.message });
  }
});

export default router;
