// Port of supabase/functions/delete-my-account.
// The caller is identified from their own access token. The user id is never taken from the body,
// so a signed-in user can only delete their own account.
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";

// Rows that reference the user, deleted before the auth user. Same list as the original.
const CLEANUP_TABLES = [
  ["welcome_email_logs", "user_id"],
  ["purchase_reminder_email_logs", "user_id"],
  ["daily_motivation_email_logs", "user_id"],
  ["daily_login_attendance", "student_id"],
  ["daily_activity_logs", "student_id"],
  ["doubt_logs", "student_id"],
  ["dpp_attempted_questions", "student_id"],
  ["dpp_topic_submissions", "student_id"],
  ["dpt_submissions", "student_id"],
  ["assignment_submissions", "student_id"],
  ["class_attendance", "student_id"],
  ["test_results", "student_id"],
  ["cart_items", "user_id"],
  ["ai_video_watch_logs", "student_id"],
  ["student_progress", "student_id"],
  ["enrollments", "student_id"],
  ["payments", "user_id"],
  ["user_push_tokens", "user_id"],
  ["user_roles", "user_id"],
  ["profiles", "id"],
];

export const router = express.Router();

router.post("/", async (req, res) => {
  const json = (body, status = 200) => res.status(status).json(body);
  try {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ error: "Not signed in" }, 401);

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return json({ error: "Your session has expired. Please log in again and retry." }, 401);
    }
    const userId = payload.sub;

    const { rows: users } = await query("SELECT id, phone FROM auth.users WHERE id = $1", [userId]);
    if (!users[0]) return json({ error: "Your session has expired. Please log in again and retry." }, 401);
    const phone = users[0].phone;

    // Remove personal data first. A failure here is reported but does not stop the rest.
    const cleanupFailures = [];
    for (const [table, column] of CLEANUP_TABLES) {
      try {
        await query(`DELETE FROM public."${table}" WHERE "${column}" = $1`, [userId]);
      } catch (e) {
        console.error(`Cleanup ${table} failed: ${e.message}`);
        cleanupFailures.push(`${table}: ${e.message}`);
      }
    }
    if (phone) {
      try {
        await query("DELETE FROM public.phone_otp_verifications WHERE phone_number = $1", [phone.replace(/\D/g, "")]);
      } catch (e) {
        cleanupFailures.push(`phone_otp_verifications: ${e.message}`);
      }
    }

    // Deleting the auth user is what stops logins. If it fails, the account still exists and the user can retry.
    try {
      await query("DELETE FROM auth.users WHERE id = $1", [userId]);
    } catch (e) {
      console.error("deleteUser failed:", e.message);
      return json({
        error: "We could not delete your account right now. Please try again.",
        cleanup_failures: cleanupFailures,
      }, 500);
    }

    return json({ success: true, cleanup_failures: cleanupFailures });
  } catch (e) {
    console.error("delete-my-account error:", e);
    return json({ error: "Something went wrong while deleting your account. Please try again." }, 500);
  }
});
