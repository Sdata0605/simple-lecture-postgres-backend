// Port of supabase/functions/verify-payment (same rules as the Supabase version). Public: the proof is the
// Razorpay signature plus a lookup of the payment at Razorpay.
// POST { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId }.
//
// SECURITY: the course list, the user and the amount come from the database and from Razorpay, never from
// the browser. Enrolment uses the courses stored on the order.
import express from "express";
import crypto from "node:crypto";
import { query } from "../_shared/db.js";

export const router = express.Router();
export const hooks = { fetch: null };

const ENROLLMENT_DAYS = 365;

function signatureMatches(expectedHex, givenHex) {
  const a = Buffer.from(String(expectedHex));
  const b = Buffer.from(String(givenHex ?? ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const json = (res, status, body) => res.status(status).json(body);

router.post("/", async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId } = req.body || {};

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !orderId) {
      return json(res, 400, { error: "Missing payment details", verified: false });
    }

    const razorpayKeyId = process.env.RAZORPAY_KEY_ID;
    const razorpaySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!razorpayKeyId || !razorpaySecret) {
      throw new Error("Razorpay keys not configured");
    }

    // 1. Signature: HMAC-SHA256 of "order_id|payment_id".
    const expected = crypto
      .createHmac("sha256", razorpaySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");
    if (!signatureMatches(expected, razorpay_signature)) {
      console.error("Signature verification failed for order", orderId);
      return json(res, 400, { error: "Payment verification failed", verified: false });
    }

    // 2. The payment row must match both our order id and this Razorpay order.
    const { rows } = await query(
      "SELECT id, user_id, status, final_amount, gateway_order_id FROM public.payments WHERE order_id = $1 LIMIT 1",
      [orderId]
    );
    const payment = rows[0];
    if (!payment || payment.gateway_order_id !== razorpay_order_id) {
      console.error("Order mismatch for", orderId);
      return json(res, 400, { error: "Order not found", verified: false });
    }

    // Already completed (for example the webhook got there first): report success, do not repeat.
    if (payment.status === "success") {
      return json(res, 200, { verified: true, alreadyProcessed: true, message: "Payment already verified" });
    }
    if (payment.status !== "pending") {
      return json(res, 400, { error: `Payment is ${payment.status}`, verified: false });
    }

    // 3. Ask Razorpay for the real payment: captured, this order, INR, exactly the stored amount (paise).
    const base = (process.env.RAZORPAY_API_BASE || "https://api.razorpay.com").replace(/\/$/, "");
    const rpRes = await (hooks.fetch ?? fetch)(`${base}/v1/payments/${encodeURIComponent(razorpay_payment_id)}`, {
      headers: { Authorization: "Basic " + Buffer.from(`${razorpayKeyId}:${razorpaySecret}`).toString("base64") },
    });
    if (!rpRes.ok) {
      console.error("Razorpay payment lookup failed", rpRes.status);
      return json(res, 502, { error: "Could not confirm payment with Razorpay", verified: false });
    }
    const rp = await rpRes.json();
    const expectedPaise = Math.round(Number(payment.final_amount) * 100);
    if (rp.order_id !== razorpay_order_id || rp.status !== "captured" || rp.currency !== "INR" || Number(rp.amount) !== expectedPaise) {
      console.error("Payment mismatch", { order: rp.order_id, status: rp.status, amount: rp.amount, expectedPaise });
      return json(res, 400, { error: "Payment amount or status does not match the order", verified: false });
    }

    // 4. Mark success only if it is still pending (prevents double processing).
    const { rows: updated } = await query(
      `UPDATE public.payments
          SET status = 'success', gateway_payment_id = $1, completed_at = now()
        WHERE id = $2 AND status = 'pending'
        RETURNING id`,
      [razorpay_payment_id, payment.id]
    );
    if (updated.length === 0) {
      return json(res, 200, { verified: true, alreadyProcessed: true, message: "Payment already verified" });
    }

    // 5. Enrol the user in the courses stored on this order (not the request body).
    const { rows: items } = await query("SELECT course_id FROM public.order_items WHERE payment_id = $1", [payment.id]);
    const expiresAt = new Date(Date.now() + ENROLLMENT_DAYS * 24 * 60 * 60 * 1000);
    for (const item of items) {
      await query(
        `INSERT INTO public.enrollments (student_id, course_id, is_active, expires_at)
         VALUES ($1, $2, true, $3)
         ON CONFLICT (student_id, course_id)
         DO UPDATE SET is_active = true, expires_at = EXCLUDED.expires_at`,
        [payment.user_id, item.course_id, expiresAt]
      );
    }

    return json(res, 200, {
      verified: true,
      message: "Payment verified and enrollment created",
      courses: items.map((i) => i.course_id),
    });
  } catch (error) {
    console.error("Payment verification error:", error?.message);
    return json(res, 500, { error: error instanceof Error ? error.message : "An error occurred", verified: false });
  }
});

export default router;
