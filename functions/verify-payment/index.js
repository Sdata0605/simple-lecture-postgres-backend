// Port of supabase/functions/verify-payment. Public, as the original: the Razorpay HMAC signature is
// the proof. POST { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId, userId, courses[] }.
// Marks the payment success and upserts one enrollment per course (365 days).
import express from "express";
import crypto from "node:crypto";
import { query } from "../_shared/db.js";

export const router = express.Router();

const ENROLLMENT_DAYS = 365;

function signatureMatches(expectedHex, givenHex) {
  const a = Buffer.from(String(expectedHex));
  const b = Buffer.from(String(givenHex ?? ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post("/", async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId, userId, courses } = req.body || {};
    console.log("Verify payment request:", { razorpay_order_id, razorpay_payment_id, orderId });

    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret) throw new Error("Razorpay secret not configured");

    const expected = crypto
      .createHmac("sha256", secret)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");

    if (!signatureMatches(expected, razorpay_signature)) {
      console.error("Signature verification failed");
      return res.status(400).json({ error: "Payment verification failed", verified: false });
    }

    console.log("Signature verified successfully");

    await query(
      `UPDATE public.payments
          SET status = 'success', gateway_payment_id = $1, gateway_order_id = $2, completed_at = now()
        WHERE order_id = $3`,
      [razorpay_payment_id, razorpay_order_id, orderId]
    );

    if (Array.isArray(courses) && courses.length > 0) {
      const expiresAt = new Date(Date.now() + ENROLLMENT_DAYS * 24 * 60 * 60 * 1000);
      for (const course of courses) {
        await query(
          `INSERT INTO public.enrollments (student_id, course_id, is_active, expires_at)
           VALUES ($1, $2, true, $3)
           ON CONFLICT (student_id, course_id)
           DO UPDATE SET is_active = true, expires_at = EXCLUDED.expires_at`,
          [userId, course.id, expiresAt]
        );
      }
      console.log("Enrollments created successfully");
    }

    return res.json({ verified: true, message: "Payment verified and enrollment created" });
  } catch (error) {
    console.error("Payment verification error:", error?.message);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "An error occurred",
      verified: false,
    });
  }
});

export default router;
