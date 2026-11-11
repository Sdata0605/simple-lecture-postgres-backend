// Port of supabase/functions/admin-delete-user. Deletes a user's rows from the related tables, then the
// auth user. Destructive, so every request must send X-Service-Key equal to the ADMIN_SERVICE_KEY env var.
// The original had no check at all; if ADMIN_SERVICE_KEY is not set, every request is refused.
//
// POST /functions/v1/admin-delete-user
// body: { user_id, phone_number? }
import crypto from "node:crypto";
import express from "express";
import { query } from "../_shared/db.js";

export const router = express.Router();

// Same tables, in the same order, as the original cleanup list.
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
  ["user_roles", "user_id"],
  ["profiles", "id"],
];

// Constant-time comparison of the header against the configured key.
function serviceKeyOk(provided) {
  const expected = process.env.ADMIN_SERVICE_KEY;
  if (!expected || typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post("/", async (req, res) => {
  if (!serviceKeyOk(req.get("x-service-key"))) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const { user_id, phone_number } = req.body ?? {};
    if (!user_id) {
      return res.status(400).json({ error: "user_id is required" });
    }

    const results = [];
    for (const [table, column] of CLEANUP_TABLES) {
      try {
        await query(`DELETE FROM public.${table} WHERE ${column} = $1`, [user_id]);
        results.push(`${table}: OK`);
      } catch (e) {
        console.log(`Cleanup ${table}: ${String(e.message).slice(0, 200)}`);
        results.push(`${table}: ERROR - ${e.message}`);
      }
    }

    if (phone_number) {
      try {
        await query("DELETE FROM public.phone_otp_verifications WHERE phone_number = $1", [phone_number]);
      } catch {
        // The original ignored this error too.
      }
      results.push("phone_otp: OK");
    }

    console.log("Attempting auth user delete");
    try {
      const del = await query("DELETE FROM auth.users WHERE id = $1 RETURNING id", [user_id]);
      if (del.rowCount === 0) {
        return res.status(500).json({ error: "User not found", error_details: { status: 404 }, cleanup_results: results });
      }
    } catch (e) {
      console.error("deleteUser error:", String(e.message).slice(0, 200));
      return res.status(500).json({ error: e.message, error_details: { message: e.message }, cleanup_results: results });
    }

    return res.json({ success: true, message: "User deleted successfully", cleanup_results: results });
  } catch (err) {
    console.error("Caught error:", String(err?.message ?? err).slice(0, 200));
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
});

export default router;
