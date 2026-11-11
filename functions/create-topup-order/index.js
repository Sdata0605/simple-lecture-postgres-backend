// Port of supabase/functions/create-topup-order. Creates a pending language top-up purchase and a
// Razorpay order for the languages the student does not already own. The caller must be signed in
// as `userId`. POST { userId, courseId, languages: string[] }.
import express from "express";
import { query } from "../_shared/db.js";
import { userIdFromBearer } from "../_shared/cdn-presentation-refresh-start-helper.js";

export const router = express.Router();
export const hooks = { fetch: null };

const sendJson = (res, status, body) => res.status(status).type("application/json").send(JSON.stringify(body));

router.post("/", async (req, res) => {
  try {
    const { userId, courseId, languages } = req.body || {};

    const callerId = userIdFromBearer(req);
    if (!callerId) return sendJson(res, 401, { error: "Unauthorized" });
    if (callerId !== userId) return sendJson(res, 403, { error: "Forbidden" });

    if (!userId || !courseId || !Array.isArray(languages) || languages.length === 0) {
      return sendJson(res, 400, { error: "Missing required fields" });
    }

    let course;
    try {
      const { rows } = await query("SELECT language_topup_price FROM public.courses WHERE id = $1", [courseId]);
      course = rows[0];
    } catch {
      course = undefined;
    }
    if (!course) return sendJson(res, 404, { error: "Course not found" });

    const pricePerLanguage = Number(course.language_topup_price) || 0;

    const { rows: purchased } = await query(
      `SELECT selected_languages FROM public.language_topup_purchases
        WHERE user_id = $1 AND course_id = $2 AND status = 'success' LIMIT 1`,
      [userId, courseId]
    );
    const alreadyPurchased = Array.isArray(purchased[0]?.selected_languages) ? purchased[0].selected_languages : [];

    const newLanguages = languages.filter((l) => !alreadyPurchased.includes(l));
    if (newLanguages.length === 0) {
      return sendJson(res, 400, { error: "All selected languages are already purchased" });
    }

    const amount = pricePerLanguage * newLanguages.length;
    const orderId = `TOPUP-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

    const razorpayKeyId = process.env.RAZORPAY_KEY_ID;
    const razorpaySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!razorpayKeyId || !razorpaySecret) {
      return sendJson(res, 500, { error: "Payment gateway not configured" });
    }

    const base = (process.env.RAZORPAY_API_BASE || "https://api.razorpay.com").replace(/\/$/, "");
    const r = await (hooks.fetch ?? fetch)(`${base}/v1/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + Buffer.from(`${razorpayKeyId}:${razorpaySecret}`).toString("base64"),
      },
      body: JSON.stringify({
        amount: amount * 100,
        currency: "INR",
        receipt: orderId,
        notes: {
          type: "language_topup",
          course_id: courseId,
          user_id: userId,
          languages: JSON.stringify(newLanguages),
        },
      }),
    });
    if (!r.ok) {
      console.error("Razorpay order creation failed, status", r.status);
      throw new Error("Failed to create Razorpay order");
    }
    const razorpayOrderId = (await r.json()).id;

    await query(
      "DELETE FROM public.language_topup_purchases WHERE user_id = $1 AND course_id = $2 AND status = 'pending'",
      [userId, courseId]
    );
    await query(
      `INSERT INTO public.language_topup_purchases
         (user_id, course_id, order_id, razorpay_order_id, selected_languages, amount_paid, status)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'pending')`,
      [userId, courseId, orderId, razorpayOrderId, JSON.stringify(newLanguages), amount]
    );

    return sendJson(res, 200, {
      orderId,
      razorpayOrderId,
      razorpayKeyId,
      amount,
      languages: newLanguages,
    });
  } catch (e) {
    console.error("Create topup order error", e.message);
    return sendJson(res, 500, { error: e instanceof Error ? e.message : "An error occurred" });
  }
});
