// Port of supabase/functions/verify-password-reset-otp.
// On a correct code it swaps the code's hash for a one-time reset token hash and returns the token.
import crypto from "node:crypto";
import { log } from "../_shared/log.js";
import express from "express";
import { query, lockedBy } from "../_shared/db.js";
import { sha256 } from "../_shared/otp.js";

const ok = (res, body) => {
  log.info("verify-password-reset-otp.reply", { result: body.error ? body.code : "ok" });
  return res.status(200).json(body);
};
const MAX_ATTEMPTS = 5;

export const router = express.Router();

// POST /functions/v1/verify-password-reset-otp  { email, otp_code }
router.post("/", lockedBy((req) => "reset:" + String(req.body?.email || "").toLowerCase(), async (req, res) => {
  try {
    const { email, otp_code } = req.body || {};
    if (!email || !otp_code) {
      return ok(res, { error: "Please enter the 6-digit code we sent to your email.", code: "INVALID_OTP" });
    }
    if (typeof email !== "string") {
      return ok(res, { error: "Please enter a valid email address.", code: "INVALID_EMAIL" });
    }
    if (!/^\d{6}$/.test(String(otp_code))) {
      return ok(res, { error: "Please enter the full 6-digit code.", code: "INVALID_OTP" });
    }

    const { rows: found } = await query(
      `SELECT * FROM public.password_reset_otps
        WHERE email = $1 AND verified = false
        ORDER BY created_at DESC LIMIT 1`,
      [email.toLowerCase()]
    );
    const otpRecord = found[0];
    log.info("verify-password-reset-otp.record_lookup", { email: String(email).toLowerCase(), found: !!otpRecord });
    if (!otpRecord) {
      return ok(res, { error: "That code isn't valid anymore. Please request a new one.", code: "EXPIRED_OTP" });
    }

    if (new Date(otpRecord.expires_at) < new Date()) {
      await query("DELETE FROM public.password_reset_otps WHERE id = $1", [otpRecord.id]);
      return ok(res, { error: "Your code has expired. Please request a new one.", code: "EXPIRED_OTP" });
    }

    if (otpRecord.attempts >= MAX_ATTEMPTS) {
      await query("DELETE FROM public.password_reset_otps WHERE id = $1", [otpRecord.id]);
      return ok(res, { error: "Too many wrong attempts. Please request a new code.", code: "TOO_MANY_ATTEMPTS" });
    }

    if (sha256(String(otp_code)) !== otpRecord.otp_hash) {
      log.warn("verify-password-reset-otp.wrong_code", { email: String(email).toLowerCase(), attempts_before: otpRecord.attempts, reason: "Wrong reset code entered" });
      await query("UPDATE public.password_reset_otps SET attempts = attempts + 1 WHERE id = $1", [otpRecord.id]);
      const remaining = MAX_ATTEMPTS - 1 - otpRecord.attempts;
      return ok(res, {
        error:
          remaining > 0
            ? `That code doesn't match. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`
            : "Too many wrong attempts. Please request a new code.",
        code: "INVALID_OTP",
      });
    }

    // Correct code: replace its hash with the hash of a fresh 64-hex reset token.
    const resetToken = crypto.randomBytes(32).toString("hex");
    await query(
      "UPDATE public.password_reset_otps SET verified = true, otp_hash = $1 WHERE id = $2",
      [sha256(resetToken), otpRecord.id]
    );

    return ok(res, {
      message: "OTP verified successfully",
      reset_token: resetToken,
      user_id: otpRecord.user_id,
    });
  } catch (e) {
    log.error("verify-password-reset-otp.exception", { error: e });
    return ok(res, { error: "Something went wrong on our end. Please try again.", code: "INTERNAL_ERROR" });
  }
}));
