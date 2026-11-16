// Port of supabase/functions/razorpay-callback (same rules as the Supabase version).
// Razorpay sends the customer back here (form POST) after a bank or card page. This verifies the payment
// on the server, enrols the student only if everything matches, and redirects to the app's result page.
//
// SECURITY: course, user and amount come from the stored order and from Razorpay, never from the form.
// Only origins in ALLOWED_RETURN_ORIGINS are used for redirects.
import express from "express";
import crypto from "node:crypto";
import { query } from "../_shared/db.js";

export const router = express.Router();
export const hooks = { fetch: null };

const ALLOWED_RETURN_ORIGINS = [
  "https://simplelecture.com",
  "https://www.simplelecture.com",
  "http://localhost:8080",
  "http://localhost:8091",
];
const ENROLLMENT_DAYS = 365;

const pickOrigin = (value) => (value && ALLOWED_RETURN_ORIGINS.includes(value) ? value : "https://simplelecture.com");

const redirect = (res, location) => res.redirect(303, location);

// Razorpay lookups can fail on a flaky network: retry with a per-attempt timeout before giving up.
export async function fetchWithRetry(url, init, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await (hooks.fetch ?? fetch)(url, { ...init, signal: AbortSignal.timeout(10000) });
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

function signatureMatches(expectedHex, givenHex) {
  const a = Buffer.from(String(expectedHex));
  const b = Buffer.from(String(givenHex ?? ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Form POST from Razorpay (urlencoded) or a manual GET with a query string.
router.use(express.urlencoded({ extended: true }));

router.all("/", async (req, res) => {
  const origin = pickOrigin(req.query.return);
  const fields = { ...req.query, ...(req.method === "POST" ? req.body || {} : {}) };
  const str = (k) => (fields[k] == null ? "" : String(fields[k]));

  // Failed bank attempts send nested error fields, e.g. error[metadata] = {"order_id":"order_...","payment_id":"pay_..."}.
  let errorMeta = {};
  try {
    errorMeta = JSON.parse(str("error[metadata]") || "{}");
  } catch {
    errorMeta = {};
  }

  const razorpayOrderId = str("razorpay_order_id") || errorMeta.order_id || "";
  const razorpayPaymentId = str("razorpay_payment_id");
  const razorpaySignature = str("razorpay_signature");

  // Find the stored order for this Razorpay order (if any).
  let payment = null;
  if (razorpayOrderId) {
    const { rows } = await query(
      "SELECT id, order_id, user_id, status, final_amount, gateway_order_id FROM public.payments WHERE gateway_order_id = $1 LIMIT 1",
      [razorpayOrderId]
    );
    payment = rows[0] || null;
  }
  const orderParam = payment?.order_id ? `?orderId=${encodeURIComponent(payment.order_id)}` : "";

  try {
    // Successful-looking callback: verify everything before enrolling.
    if (razorpayPaymentId && razorpayOrderId && razorpaySignature) {
      const keyId = process.env.RAZORPAY_KEY_ID;
      const secret = process.env.RAZORPAY_KEY_SECRET;
      if (!keyId || !secret || !payment) {
        console.error("Callback: missing keys or unknown order", razorpayOrderId);
        return redirect(res, `${origin}/payment-failed${orderParam}`);
      }

      // 1. Signature.
      const expected = crypto.createHmac("sha256", secret).update(`${razorpayOrderId}|${razorpayPaymentId}`).digest("hex");
      if (!signatureMatches(expected, razorpaySignature)) {
        console.error("Callback: bad signature for", razorpayOrderId);
        return redirect(res, `${origin}/payment-failed${orderParam}`);
      }

      // 2. Already processed (for example the webhook or a retry got there first).
      if (payment.status === "success") return redirect(res, `${origin}/payment-success${orderParam}`);
      if (payment.status !== "pending") return redirect(res, `${origin}/payment-failed${orderParam}`);

      // 3. Razorpay must confirm: captured, same order, INR, exact stored amount.
      const base = (process.env.RAZORPAY_API_BASE || "https://api.razorpay.com").replace(/\/$/, "");
      let rp;
      try {
        rp = await fetchWithRetry(`${base}/v1/payments/${encodeURIComponent(razorpayPaymentId)}`, {
          headers: { Authorization: "Basic " + Buffer.from(`${keyId}:${secret}`).toString("base64") },
        });
      } catch (netErr) {
        // Razorpay could not be reached. The payment may still have succeeded, so do not fail the order here:
        // leave it pending (the webhook or a retry can complete it) and send the customer to the pending page.
        console.error("Callback: Razorpay unreachable, leaving order pending", razorpayOrderId, netErr?.message);
        return redirect(res, `${origin}/payment-success${orderParam}`);
      }
      if (!rp.ok) {
        console.error("Callback: Razorpay lookup failed", rp.status);
        return redirect(res, `${origin}/payment-failed${orderParam}`);
      }
      const rpPayment = await rp.json();
      const expectedPaise = Math.round(Number(payment.final_amount) * 100);
      if (
        rpPayment.order_id !== razorpayOrderId ||
        rpPayment.status !== "captured" ||
        rpPayment.currency !== "INR" ||
        Number(rpPayment.amount) !== expectedPaise
      ) {
        console.error("Callback: payment does not match order", razorpayOrderId);
        return redirect(res, `${origin}/payment-failed${orderParam}`);
      }

      // 4. Mark success once (only from pending), then enrol from the stored order items.
      const { rows: updated } = await query(
        `UPDATE public.payments
            SET status = 'success', gateway_payment_id = $1, completed_at = now()
          WHERE id = $2 AND status = 'pending'
          RETURNING id`,
        [razorpayPaymentId, payment.id]
      );
      if (updated.length > 0) {
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
      }
      return redirect(res, `${origin}/payment-success${orderParam}`);
    }

    // Anything else (for example a failed bank attempt): record the failure if the order is still pending.
    if (payment && payment.status === "pending") {
      const reason = str("error[description]") || str("error[reason]") || "Payment was not completed";
      await query("UPDATE public.payments SET status = 'failed', error_message = $1 WHERE id = $2 AND status = 'pending'", [
        reason,
        payment.id,
      ]);
    }
    return redirect(res, `${origin}/payment-failed${orderParam}`);
  } catch (err) {
    console.error("Callback error:", err?.message);
    return redirect(res, `${origin}/payment-failed${orderParam}`);
  }
});

export default router;
