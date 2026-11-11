// Port of supabase/functions/whatsapp-daily-nudge. Sends the "daily_doubt" WhatsApp template (via Wacto)
// to every active enrolled student who has a phone number, once per student. Run by a scheduler.
// POST (or GET) with Authorization: Bearer <WHATSAPP_NUDGE_CRON_KEY or SERVICE_ROLE_KEY>.
// Env: WACTO_API_TOKEN (required), WACTO_SENDER_ID (required; was hard-coded in the original).
import express from "express";
import crypto from "node:crypto";
import { query } from "../_shared/db.js";

export const router = express.Router();

const WACTO_BASE = "https://api.wacto.app/api/v1.0";

function bearerMatches(req, expected) {
  const given = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.all("/", async (req, res) => {
  try {
    if (!bearerMatches(req, process.env.WHATSAPP_NUDGE_CRON_KEY) && !bearerMatches(req, process.env.SERVICE_ROLE_KEY)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const token = process.env.WACTO_API_TOKEN;
    if (!token) throw new Error("WACTO_API_TOKEN not configured");
    const sender = process.env.WACTO_SENDER_ID;
    if (!sender) throw new Error("WACTO_SENDER_ID not configured");

    // Enrolled students with a phone number, one entry per student.
    const { rows } = await query(
      `SELECT p.id, p.full_name, p.phone_number
         FROM public.enrollments e
         JOIN public.profiles p ON p.id = e.student_id
        WHERE e.is_active = true`
    );

    const seen = new Set();
    const students = [];
    for (const profile of rows) {
      if (!profile.phone_number || seen.has(profile.id)) continue;
      seen.add(profile.id);
      students.push({
        id: profile.id,
        name: profile.full_name || "Student",
        phone: profile.phone_number.replace(/\D/g, ""),
      });
    }

    console.log(`Sending daily nudge to ${students.length} students`);

    let sent = 0;
    let failed = 0;
    for (const student of students) {
      try {
        const phone = student.phone.startsWith("91") ? student.phone : `91${student.phone}`;
        const response = await fetch(`${WACTO_BASE}/messages/send-template/${encodeURIComponent(sender)}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: phone,
            type: "template",
            template: {
              name: "daily_doubt",
              language: { code: "en" },
              components: [{ type: "body", parameters: [{ type: "text", text: student.name }] }],
            },
          }),
        });
        if (response.ok) {
          sent++;
        } else {
          console.error(`Failed to send nudge: HTTP ${response.status}`);
          failed++;
        }
        // Small delay to avoid rate limiting
        await new Promise((r) => setTimeout(r, 100));
      } catch (err) {
        console.error("Error sending nudge:", err?.message);
        failed++;
      }
    }

    return res.json({ success: true, sent, failed, total: students.length });
  } catch (error) {
    console.error("Daily nudge error:", error?.message);
    return res.status(500).json({ error: error.message });
  }
});

export default router;
