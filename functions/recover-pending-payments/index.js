// Port of supabase/functions/recover-pending-payments.
// Cron job: finds payments still 'pending' after 15 minutes that have a Razorpay order id, asks
// Razorpay whether the order was captured, and if so marks the payment successful and enrols the buyer.
//
// Authorisation: the caller must send `Authorization: Bearer <CRON_SECRET>`. (The original had no
// check; a scheduled job must not be open to the internet.) RAZORPAY_API_BASE may override the API host.
import express from "express";
import { query } from "../_shared/db.js";

const DEFAULT_RAZORPAY_BASE = "https://api.razorpay.com/v1";
const ENROLMENT_TERM_MS = 365 * 24 * 60 * 60 * 1000;

export const router = express.Router();

async function enrolBuyer(paymentId, userId) {
  const { rows: items } = await query("SELECT course_id FROM public.order_items WHERE payment_id = $1", [paymentId]);
  if (items.length === 0) return;
  const expiresAt = new Date(Date.now() + ENROLMENT_TERM_MS).toISOString();
  try {
    for (const item of items) {
      await query(
        `INSERT INTO public.enrollments (student_id, course_id, is_active, expires_at)
         VALUES ($1, $2, true, $3)
         ON CONFLICT (student_id, course_id) DO UPDATE SET is_active = true, expires_at = EXCLUDED.expires_at`,
        [userId, item.course_id, expiresAt]
      );
    }
    console.log(`Created ${items.length} enrollment(s) for user ${userId}`);
  } catch (err) {
    console.error(`Failed to create enrollments for payment ${paymentId}:`, err.message);
  }
}

router.all("/", async (req, res) => {
  const json = (status, body) => res.status(status).json(body);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) throw new Error("Razorpay credentials not configured");

    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) return json(500, { error: "CRON_SECRET is not configured" });
    if (req.headers.authorization !== `Bearer ${cronSecret}`) return json(401, { error: "Unauthorized" });

    const base = (process.env.RAZORPAY_API_BASE || DEFAULT_RAZORPAY_BASE).replace(/\/$/, "");

    const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { rows: pendingPayments } = await query(
      `SELECT id, order_id, user_id, gateway_order_id, amount_inr, created_at
         FROM public.payments
        WHERE status = 'pending' AND gateway_order_id IS NOT NULL AND created_at < $1
        LIMIT 200`,
      [cutoff]
    );
    if (pendingPayments.length === 0) {
      return json(200, { message: "No pending payments to recover", recovered: 0 });
    }
    console.log(`Found ${pendingPayments.length} pending payments to check`);

    const authHeader = "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    let recovered = 0;
    const results = [];

    for (const payment of pendingPayments) {
      try {
        const rzpRes = await fetch(`${base}/orders/${encodeURIComponent(payment.gateway_order_id)}/payments`, {
          headers: { Authorization: authHeader },
        });
        if (!rzpRes.ok) {
          console.warn(`Razorpay API error for order ${payment.gateway_order_id}: ${rzpRes.status}`);
          results.push({ order_id: payment.order_id, status: "razorpay_error", code: rzpRes.status });
          continue;
        }

        const rzpData = await rzpRes.json();
        const items = rzpData.items || rzpData;
        const captured = (Array.isArray(items) ? items : []).find((p) => p.status === "captured");
        if (!captured) {
          console.log(`No captured payment for order ${payment.gateway_order_id}, skipping`);
          results.push({ order_id: payment.order_id, status: "no_capture" });
          continue;
        }
        console.log(`Found captured payment ${captured.id} for order ${payment.gateway_order_id}`);

        // Only a pending row is updated, so a payment is never processed twice.
        const updated = await query(
          `UPDATE public.payments
              SET status = 'success', gateway_payment_id = $2, completed_at = $3, updated_at = $3
            WHERE id = $1 AND status = 'pending'`,
          [payment.id, captured.id, new Date().toISOString()]
        );
        if (updated.rowCount === 0) {
          results.push({ order_id: payment.order_id, status: "update_error" });
          continue;
        }

        await enrolBuyer(payment.id, payment.user_id);
        recovered++;
        results.push({ order_id: payment.order_id, status: "recovered", razorpay_id: captured.id });
      } catch (err) {
        console.error(`Error processing payment ${payment.order_id}:`, err.message);
        results.push({ order_id: payment.order_id, status: "error", message: err.message });
      }
    }

    console.log(`Recovery complete: ${recovered}/${pendingPayments.length} payments recovered`);
    return json(200, { recovered, total_checked: pendingPayments.length, results });
  } catch (error) {
    console.error("Payment recovery error:", error?.message);
    return json(500, { error: error instanceof Error ? error.message : "An error occurred" });
  }
});

export default router;
