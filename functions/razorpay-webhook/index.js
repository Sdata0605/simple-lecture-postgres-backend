// Port of supabase/functions/razorpay-webhook.
// Verifies Razorpay's HMAC-SHA256 signature over the raw request body, then marks the matching
// payment successful and creates enrollments for its order items.
//
// IMPORTANT for mounting: the signature is computed over the exact bytes Razorpay sent, so this
// route must be mounted BEFORE the app-wide express.json() middleware in src/app.js. This router
// reads the body itself with express.raw(); if it receives an already-parsed body it refuses.
import express from "express";
import crypto from "node:crypto";
import { query } from "../_shared/db.js";

export const router = express.Router();

const json = (res, status, body) => res.status(status).json(body);

function signatureMatches(rawBody, signature, secret) {
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post(
  "/",
  express.raw({ type: () => true, limit: "1mb" }),
  async (req, res) => {
    try {
      const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
      if (!secret) {
        console.error("RAZORPAY_WEBHOOK_SECRET not configured");
        return res.status(500).type("text/plain").send("Server misconfigured");
      }

      if (!Buffer.isBuffer(req.body)) {
        console.error("razorpay-webhook: raw body unavailable; mount this route before express.json()");
        return res.status(500).type("text/plain").send("Server misconfigured");
      }
      const rawBody = req.body;
      const signature = req.headers["x-razorpay-signature"];
      if (!signature) {
        console.warn("Missing x-razorpay-signature header");
        return res.status(400).type("text/plain").send("Missing signature");
      }
      if (!signatureMatches(rawBody, signature, secret)) {
        console.warn("Webhook signature verification failed");
        return res.status(400).type("text/plain").send("Invalid signature");
      }

      const payload = JSON.parse(rawBody.toString("utf8"));
      const event = payload.event;
      if (event !== "payment.captured") {
        console.log(`Ignoring event: ${event}`);
        return json(res, 200, { status: "ignored", event });
      }

      const paymentEntity = payload.payload?.payment?.entity;
      if (!paymentEntity) {
        console.error("No payment entity in payload");
        return res.status(400).type("text/plain").send("Invalid payload");
      }
      const razorpayOrderId = paymentEntity.order_id;
      const razorpayPaymentId = paymentEntity.id;
      console.log(`Processing payment.captured: order=${razorpayOrderId}, payment=${razorpayPaymentId}`);

      const { rows } = await query(
        "SELECT id, user_id, status FROM public.payments WHERE gateway_order_id = $1 LIMIT 1",
        [razorpayOrderId]
      );
      const payment = rows[0];
      if (!payment) {
        console.error("Payment not found for order:", razorpayOrderId);
        // 200 so Razorpay does not retry.
        return json(res, 200, { status: "not_found" });
      }
      if (payment.status !== "pending") {
        console.log(`Payment ${payment.id} already ${payment.status}, skipping`);
        return json(res, 200, { status: "already_processed" });
      }

      // The status condition in the WHERE clause prevents a race with a second delivery.
      const updated = await query(
        `UPDATE public.payments
            SET status = 'success', gateway_payment_id = $2, completed_at = $3, updated_at = $3
          WHERE id = $1 AND status = 'pending'`,
        [payment.id, razorpayPaymentId, new Date().toISOString()]
      );
      if (updated.rowCount === 0) {
        return json(res, 200, { status: "already_processed" });
      }
      console.log(`Payment ${payment.id} updated to success`);

      const { rows: items } = await query(
        "SELECT course_id FROM public.order_items WHERE payment_id = $1",
        [payment.id]
      );
      if (items.length > 0) {
        const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
        try {
          for (const item of items) {
            await query(
              `INSERT INTO public.enrollments (student_id, course_id, is_active, expires_at)
               VALUES ($1, $2, true, $3)
               ON CONFLICT (student_id, course_id) DO UPDATE SET is_active = true, expires_at = EXCLUDED.expires_at`,
              [payment.user_id, item.course_id, expiresAt]
            );
          }
          console.log(`Created ${items.length} enrollment(s) for user ${payment.user_id}`);
        } catch (enrollError) {
          console.error("Failed to create enrollments:", enrollError.message);
        }
      }

      return json(res, 200, { status: "processed" });
    } catch (error) {
      console.error("Webhook error:", error?.message);
      return json(res, 500, { error: "Internal error" });
    }
  }
);

router.all("/", (req, res) => res.status(405).type("text/plain").send("Method not allowed"));

export default router;
