// Port of supabase/functions/validate-promo-code. Public, as the original was: checkout calls it
// before any payment. POST { code, course_id? } -> { valid, ... } (status codes as the original).
import express from "express";
import { query } from "../_shared/db.js";

export const router = express.Router();

const fail = (message) => ({ valid: false, message });

router.post("/", async (req, res) => {
  try {
    const { code, course_id } = req.body || {};

    if (!code) return res.status(400).json(fail("Promo code is required"));

    let discount = null;
    try {
      const { rows } = await query("SELECT * FROM public.discount_codes WHERE code = $1 LIMIT 1", [String(code).toUpperCase()]);
      discount = rows[0] || null;
    } catch {
      discount = null;
    }
    if (!discount) return res.json(fail("Invalid promo code"));

    if (!discount.is_active) return res.json(fail("This promo code is no longer active"));

    const now = new Date();
    const validFrom = discount.valid_from ? new Date(discount.valid_from) : null;
    const validUntil = discount.valid_until ? new Date(discount.valid_until) : null;

    if (validFrom && now < validFrom) return res.json(fail("This promo code is not yet valid"));
    if (validUntil && now > validUntil) return res.json(fail("This promo code has expired"));

    if (discount.course_id && discount.course_id !== course_id) {
      return res.json(fail("This promo code is not valid for this course"));
    }

    if (discount.max_uses && discount.times_used >= discount.max_uses) {
      return res.json(fail("This promo code has reached its usage limit"));
    }

    return res.json({
      valid: true,
      id: discount.id,
      code: discount.code,
      description: discount.description,
      discount_percent: discount.discount_percent,
      discount_amount: discount.discount_amount,
      message: "Promo code applied successfully",
    });
  } catch (error) {
    console.error("Error validating promo code:", error?.message);
    return res.status(500).json(fail("Failed to validate promo code"));
  }
});

export default router;
