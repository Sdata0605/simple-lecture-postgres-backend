// Port of supabase/functions/send-welcome-email. Sends the one-time welcome email and logs it in
// welcome_email_logs. POST { user_id, email, full_name? }.
// Callers: the service key, or the user's own JWT (sub must equal user_id).
// Delivery goes through _shared/mail.js: MAIL_MODE=dry-run (default) records the message and sends nothing.
import express from "express";
import { query } from "../_shared/db.js";
import { sendMail } from "../_shared/mail.js";
import { isServiceCall, jwtUserId } from "../_shared/send-verification-notification-helper.js";

export const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function welcomeHtml(userName) {
  return `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 0; background-color: #ffffff;">
          <div style="background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); padding: 40px 30px; text-align: center; border-radius: 0 0 24px 24px;">
            <h1 style="color: #ffffff; margin: 0; font-size: 32px; font-weight: 700;">Welcome to SimpleLecture! 🎓</h1>
            <p style="color: rgba(255,255,255,0.9); margin: 12px 0 0; font-size: 16px;">Your gateway to smarter learning</p>
          </div>

          <div style="padding: 36px 30px;">
            <p style="color: #374151; font-size: 18px; margin: 0 0 16px;">Hi ${userName},</p>

            <p style="color: #4b5563; font-size: 16px; line-height: 1.7; margin: 0 0 16px;">
              We're thrilled to have you join the SimpleLecture family! 🎉
            </p>

            <p style="color: #4b5563; font-size: 16px; line-height: 1.7; margin: 0 0 24px;">
              SimpleLecture is designed to make your learning journey smoother, smarter, and more enjoyable.
              With AI-powered tutoring, expert-crafted courses, interactive practice, and live classes —
              everything you need to ace your exams is right here.
            </p>

            <div style="background-color: #f8f7ff; border-radius: 12px; padding: 24px; margin: 24px 0;">
              <h3 style="color: #6366f1; margin: 0 0 16px; font-size: 18px;">Here's what you can do:</h3>
              <ul style="color: #4b5563; font-size: 15px; line-height: 2; margin: 0; padding-left: 20px;">
                <li>📚 Browse our expert-designed courses</li>
                <li>🤖 Get instant doubt resolution with AI Tutor</li>
                <li>📝 Practice with thousands of MCQs & DPPs</li>
                <li>🎥 Watch video lectures anytime, anywhere</li>
                <li>📊 Track your progress with detailed analytics</li>
              </ul>
            </div>

            <div style="text-align: center; margin: 32px 0;">
              <a href="https://simplelecture.com"
                 style="display: inline-block; background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); color: #ffffff; text-decoration: none; padding: 16px 40px; border-radius: 8px; font-size: 18px; font-weight: 600;">
                Explore Courses →
              </a>
            </div>

            <p style="color: #9ca3af; font-size: 14px; text-align: center; margin: 24px 0 0;">
              If you have any questions, our support team is always here to help!
            </p>
          </div>

          <div style="padding: 20px 30px; text-align: center; border-top: 1px solid #f3f4f6;">
            <p style="color: #9ca3af; font-size: 12px; margin: 0;">
              Welcome aboard! 💜 — Team SimpleLecture
            </p>
          </div>
        </div>
      `;
}

async function logEmail(userId, email, status, errorMessage) {
  await query(
    "INSERT INTO public.welcome_email_logs (user_id, email, status, error_message) VALUES ($1, $2, $3, $4)",
    [userId, email, status, errorMessage ?? null]
  );
}

router.post("/", async (req, res) => {
  const body = req.body || {};
  try {
    const { user_id, email, full_name } = body;

    const authorized = isServiceCall(req) || (user_id && jwtUserId(req) === user_id);
    if (!authorized) return res.status(401).json({ error: "Unauthorized" });

    if (!user_id || !email) {
      return res.status(400).json({ error: "user_id and email required" });
    }
    if (!UUID_RE.test(String(user_id))) {
      return res.status(400).json({ error: "user_id must be a UUID" });
    }

    const userName = full_name || "Student";
    console.log("[Welcome Email] Sending welcome email");

    const { rows: existing } = await query(
      "SELECT id FROM public.welcome_email_logs WHERE user_id = $1 AND status = 'sent' LIMIT 1",
      [user_id]
    );
    if (existing.length) {
      console.log("[Welcome Email] Already sent to this user, skipping");
      return res.json({ message: "Already sent" });
    }

    if (process.env.MAIL_MODE === "smtp" && (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS)) {
      throw new Error("SMTP credentials not configured");
    }

    await sendMail({
      to: email,
      subject: "🎉 Welcome to SimpleLecture! Your Learning Journey Starts Now",
      html: welcomeHtml(userName),
      text: `Hi ${userName}, welcome to SimpleLecture! Explore courses at https://simplelecture.com`,
    });

    await logEmail(user_id, email, "sent", null);
    console.log("[Welcome Email] Successfully sent");
    return res.json({ message: "Welcome email sent", email });
  } catch (error) {
    console.error("[Welcome Email] Error:", error?.message);
    try {
      if (body.user_id && UUID_RE.test(String(body.user_id))) {
        await logEmail(body.user_id, body.email || "unknown", "failed", String(error?.message || "").substring(0, 500));
      }
    } catch {
      // Logging the failure must not hide the original error.
    }
    return res.status(500).json({ error: error?.message || "Internal server error" });
  }
});

export default router;
