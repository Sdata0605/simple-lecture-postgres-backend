// Port of supabase/functions/create-payment-order. Creates a pending payment, its order items and
// (when Razorpay keys are configured) a Razorpay order. The caller must be signed in as `userId`.
// POST { amount, courses: [{ id, price }], customerInfo, promoCode, userId }.
//
// Razorpay URL comes from RAZORPAY_API_BASE (default https://api.razorpay.com). The keys come from
// RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET. Customer details are never logged.
import express from "express";
import { query } from "../_shared/db.js";
import { userIdFromBearer } from "../_shared/cdn-presentation-refresh-start-helper.js";

export const router = express.Router();
export const hooks = { fetch: null };

const sendJson = (res, status, body) => res.status(status).type("application/json").send(JSON.stringify(body));

router.post("/", async (req, res) => {
  try {
    const { amount, courses, customerInfo, promoCode, userId } = req.body || {};

    const callerId = userIdFromBearer(req);
    if (!callerId) return sendJson(res, 401, { error: "Unauthorized" });
    if (callerId !== userId) return sendJson(res, 403, { error: "Forbidden" });

    if (!userId || !Array.isArray(courses) || courses.length === 0) {
      return sendJson(res, 400, { error: "Missing required fields" });
    }

    const orderId = `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

    let discountAmount = 0;
    let promoCodeId = null;
    if (promoCode) {
      const { rows } = await query("SELECT * FROM public.discount_codes WHERE code = $1 LIMIT 1", [
        String(promoCode).toUpperCase(),
      ]);
      const discount = rows[0];
      if (discount?.is_active) {
        promoCodeId = discount.id;
        if (discount.discount_percent) {
          discountAmount = Math.round((amount * discount.discount_percent) / 100);
        } else if (discount.discount_amount) {
          discountAmount = discount.discount_amount;
        }
      }
    }

    const finalAmount = Math.max(0, amount - discountAmount);

    const razorpayKeyId = process.env.RAZORPAY_KEY_ID;
    const razorpaySecret = process.env.RAZORPAY_KEY_SECRET;
    let razorpayOrderId = null;

    if (razorpayKeyId && razorpaySecret) {
      try {
        const base = (process.env.RAZORPAY_API_BASE || "https://api.razorpay.com").replace(/\/$/, "");
        const r = await (hooks.fetch ?? fetch)(`${base}/v1/orders`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Basic " + Buffer.from(`${razorpayKeyId}:${razorpaySecret}`).toString("base64"),
          },
          body: JSON.stringify({
            amount: finalAmount * 100,
            currency: "INR",
            receipt: orderId,
            notes: {
              customer_name: customerInfo?.fullName || "",
              customer_email: customerInfo?.email || "",
              customer_phone: customerInfo?.phone || "",
            },
          }),
        });
        if (r.ok) {
          const order = await r.json();
          razorpayOrderId = order.id;
        } else {
          console.error("Razorpay order creation failed, status", r.status);
        }
      } catch (e) {
        console.error("Razorpay API error", e.message);
      }
    }

    const { rows: paymentRows } = await query(
      `INSERT INTO public.payments
         (order_id, user_id, amount_inr, discount_amount, final_amount, status, payment_gateway, gateway_order_id, metadata)
       VALUES ($1, $2, $3, $4, $5, 'pending', 'razorpay', $6, $7::jsonb)
       RETURNING id`,
      [
        orderId,
        userId,
        amount,
        discountAmount,
        finalAmount,
        razorpayOrderId,
        JSON.stringify({ customerInfo, promoCode: promoCode || null }),
      ]
    );
    const paymentId = paymentRows[0].id;

    for (const course of courses) {
      await query(
        "INSERT INTO public.order_items (payment_id, course_id, price_inr) VALUES ($1, $2, $3)",
        [paymentId, course?.id, course?.price || 0]
      );
    }

    if (promoCodeId) {
      await query("UPDATE public.discount_codes SET times_used = COALESCE(times_used, 0) + 1 WHERE id = $1", [
        promoCodeId,
      ]);
    }

    return sendJson(res, 200, {
      orderId,
      amount: finalAmount,
      status: "created",
      paymentId,
      razorpayOrderId,
      razorpayKeyId,
    });
  } catch (e) {
    console.error("Payment order error", e.message);
    return sendJson(res, 500, { error: e instanceof Error ? e.message : "An error occurred" });
  }
});
