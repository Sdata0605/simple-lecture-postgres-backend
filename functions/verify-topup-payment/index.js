// Port of supabase/functions/verify-topup-payment. Public, as the original: the Razorpay HMAC
// signature is the proof. POST { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId,
// userId, courseId, languages[] }. Unlocks the purchased languages on language_topup_purchases.
import express from "express";
import crypto from "node:crypto";
import { query } from "../_shared/db.js";

export const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function signatureMatches(expectedHex, givenHex) {
  const a = Buffer.from(String(expectedHex));
  const b = Buffer.from(String(givenHex ?? ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The original read these with supabase-js, which reports errors instead of throwing, so a
// lookup that cannot match (for example a malformed id) simply finds nothing.
async function lookupOrNull(sql, params) {
  try {
    const { rows } = await query(sql, params);
    return rows[0] || null;
  } catch {
    return null;
  }
}

router.post("/", async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId, userId, courseId, languages } = req.body || {};
    console.log("Verify topup payment request:", { razorpay_order_id, orderId, userId, courseId, languages });

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !orderId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret) return res.status(500).json({ error: "Payment gateway not configured" });

    const expected = crypto
      .createHmac("sha256", secret)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");
    if (!signatureMatches(expected, razorpay_signature)) {
      console.error("Signature verification failed");
      return res.status(400).json({ error: "Payment verification failed" });
    }

    console.log("Signature verified successfully");

    const validUser = UUID_RE.test(String(userId ?? ""));
    const validCourse = UUID_RE.test(String(courseId ?? ""));

    const pending = validUser
      ? await lookupOrNull(
          "SELECT selected_languages FROM public.language_topup_purchases WHERE order_id = $1 AND user_id = $2 LIMIT 1",
          [orderId, userId]
        )
      : null;

    const newLanguages = pending?.selected_languages || languages || [];

    const existing = validUser && validCourse
      ? await lookupOrNull(
          `SELECT id, selected_languages FROM public.language_topup_purchases
            WHERE user_id = $1 AND course_id = $2 AND status = 'success' LIMIT 1`,
          [userId, courseId]
        )
      : null;

    if (existing) {
      const existingLanguages = existing.selected_languages || [];
      const merged = [...new Set([...existingLanguages, ...newLanguages])];

      await query(
        "UPDATE public.language_topup_purchases SET selected_languages = $1::jsonb, completed_at = now() WHERE id = $2",
        [JSON.stringify(merged), existing.id]
      );
      await query("DELETE FROM public.language_topup_purchases WHERE order_id = $1", [orderId]);
      console.log("Languages merged successfully:", merged);
    } else {
      await query(
        `UPDATE public.language_topup_purchases
            SET status = 'success', razorpay_payment_id = $1, completed_at = now()
          WHERE order_id = $2 AND user_id = $3`,
        [razorpay_payment_id, orderId, userId]
      );
      console.log("Purchase completed successfully:", orderId);
    }

    return res.json({ success: true, message: "Payment verified and languages unlocked" });
  } catch (error) {
    console.error("Verify topup payment error:", error?.message);
    return res.status(500).json({ error: error instanceof Error ? error.message : "An error occurred" });
  }
});

export default router;
