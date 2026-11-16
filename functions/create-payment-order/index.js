// Port of supabase/functions/create-payment-order (same rules as the Supabase version).
// POST { courses: [{ id }], customerInfo, promoCode, userId }. The caller must be signed in as `userId`.
//
// SECURITY: the browser's amounts are ignored. The server reads each course price from the database,
// applies the promo code once to the GST-inclusive subtotal, and derives base = round(total / 1.18),
// GST = total - base. Mirrors src/lib/gst.ts on the web client.
//
// Razorpay URL comes from RAZORPAY_API_BASE (default https://api.razorpay.com). The keys come from
// RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET. Customer details are never logged.
import express from "express";
import { query } from "../_shared/db.js";
import { userIdFromBearer } from "../_shared/cdn-presentation-refresh-start-helper.js";

export const router = express.Router();
export const hooks = { fetch: null };

const GST_DIVISOR = 1.18;

const sendJson = (res, status, body) => res.status(status).type("application/json").send(JSON.stringify(body));

router.post("/", async (req, res) => {
  try {
    const { courses, customerInfo, promoCode, userId } = req.body || {};

    const callerId = userIdFromBearer(req);
    if (!callerId) return sendJson(res, 401, { error: "Unauthorized" });
    if (callerId !== userId) return sendJson(res, 403, { error: "Forbidden" });

    if (!userId || !Array.isArray(courses) || courses.length === 0) {
      return sendJson(res, 400, { error: "Missing required fields" });
    }

    // 1. Course prices come from the database (client amounts are never used).
    const courseIds = [...new Set(courses.map((c) => c?.id).filter(Boolean))];
    const { rows: dbCourses } = await query(
      "SELECT id, name, price_inr, is_active, is_coming_soon FROM public.courses WHERE id = ANY($1::uuid[])",
      [courseIds]
    );
    if (dbCourses.length !== courseIds.length) {
      return sendJson(res, 400, { error: "One or more courses were not found" });
    }
    for (const c of dbCourses) {
      if (!c.is_active || c.is_coming_soon) {
        return sendJson(res, 400, { error: `Course "${c.name}" is not open for enrollment` });
      }
    }

    const subtotal = dbCourses.reduce((sum, c) => sum + Math.max(0, Math.round(Number(c.price_inr) || 0)), 0);

    // 2. Promo code: applied once, to the GST-inclusive subtotal.
    let discountAmount = 0;
    let promoCodeId = null;
    if (promoCode) {
      const { rows } = await query("SELECT * FROM public.discount_codes WHERE code = $1 LIMIT 1", [
        String(promoCode).toUpperCase(),
      ]);
      const discount = rows[0];
      const expired = discount?.valid_until ? new Date(discount.valid_until).getTime() < Date.now() : false;
      const exhausted = discount?.max_uses ? (discount.times_used || 0) >= discount.max_uses : false;
      const courseMismatch = discount?.course_id ? !courseIds.includes(discount.course_id) : false;
      if (discount && discount.is_active && !expired && !exhausted && !courseMismatch) {
        promoCodeId = discount.id;
        if (discount.discount_percent) {
          discountAmount = Math.round((subtotal * discount.discount_percent) / 100);
        } else if (discount.discount_amount) {
          discountAmount = discount.discount_amount;
        }
        discountAmount = Math.min(discountAmount, subtotal);
      }
    }

    // 3. Final inclusive total and GST split.
    const finalAmount = Math.max(0, subtotal - discountAmount);
    if (finalAmount <= 0) {
      return sendJson(res, 400, { error: "Amount must be greater than zero for paid checkout" });
    }
    const baseAmount = Math.round(finalAmount / GST_DIVISOR);
    const gstAmount = finalAmount - baseAmount;

    const orderId = `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

    // 4. Razorpay order (only when keys are configured).
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

    // 5. Pending payment, then one order item per course at its database price.
    const { rows: paymentRows } = await query(
      `INSERT INTO public.payments
         (order_id, user_id, amount_inr, discount_amount, final_amount, status, payment_gateway, gateway_order_id, metadata)
       VALUES ($1, $2, $3, $4, $5, 'pending', 'razorpay', $6, $7::jsonb)
       RETURNING id`,
      [
        orderId,
        userId,
        subtotal,
        discountAmount,
        finalAmount,
        razorpayOrderId,
        JSON.stringify({
          customerInfo,
          promoCode: promoCode || null,
          gst_inclusive: true,
          base_amount: baseAmount,
          gst_amount: gstAmount,
          gst_rate: 0.18,
        }),
      ]
    );
    const paymentId = paymentRows[0].id;

    for (const course of dbCourses) {
      await query(
        "INSERT INTO public.order_items (payment_id, course_id, price_inr) VALUES ($1, $2, $3)",
        [paymentId, course.id, Math.max(0, Math.round(Number(course.price_inr) || 0))]
      );
    }

    // 6. Promo usage counter.
    if (promoCodeId) {
      await query("UPDATE public.discount_codes SET times_used = COALESCE(times_used, 0) + 1 WHERE id = $1", [
        promoCodeId,
      ]);
    }

    return sendJson(res, 200, {
      orderId,
      amount: finalAmount,
      baseAmount,
      gstAmount,
      discountAmount,
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
