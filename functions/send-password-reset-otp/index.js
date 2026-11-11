// Port of supabase/functions/send-password-reset-otp.
// Like the original, most outcomes return HTTP 200 with { error, code } or { message }.
// The generic "if an account exists" reply stops the endpoint revealing which emails are registered.
import express from "express";
import { log } from "../_shared/log.js";
import { query, lockedBy } from "../_shared/db.js";
import { generateOtp, sha256, minutesFromNow } from "../_shared/otp.js";
import { sendMail } from "../_shared/mail.js";

const GENERIC = "If an account exists with this email, you will receive an OTP shortly.";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const router = express.Router();

// POST /functions/v1/send-password-reset-otp  { email }
router.post("/", lockedBy((req) => "reset:" + String(req.body?.email || "").toLowerCase(), async (req, res) => {
  const ok = (body) => {
    log.info("send-password-reset-otp.reply", { result: body.error ? body.code : body.message ? "generic_reply" : "ok" });
    return res.status(200).json(body);
  };
  try {
    const { email } = req.body || {};
    if (!email || typeof email !== "string") {
      return ok({ error: "Please enter your email address.", code: "INVALID_EMAIL" });
    }
    if (!EMAIL_RE.test(email)) {
      return ok({ error: "Please enter a valid email address.", code: "INVALID_EMAIL" });
    }

    const cleanEmail = email.toLowerCase();
    const { rows: users } = await query(
      "SELECT id, email FROM auth.users WHERE lower(email) = $1 LIMIT 1",
      [cleanEmail]
    );
    const user = users[0];
    if (!user) {
      log.warn("send-password-reset-otp.no_account", { email: cleanEmail, reason: "No account exists for this email" });
      return ok({ message: GENERIC });
    }
    log.info("send-password-reset-otp.account_found", { email: cleanEmail, user_id: user.id });

    // Rate limit: max 3 requests per user per 10 minutes.
    const { rows: recent } = await query(
      `SELECT count(*)::int AS n FROM public.password_reset_otps
        WHERE user_id = $1 AND created_at >= now() - interval '10 minutes'`,
      [user.id]
    );
    if ((recent[0]?.n ?? 0) >= 3) {
      return ok({ error: "Too many requests. Please wait a few minutes and try again.", code: "RATE_LIMITED" });
    }

    // Only the newest code is valid, as in the original.
    await query("DELETE FROM public.password_reset_otps WHERE user_id = $1", [user.id]);

    const otp = generateOtp();
    await query(
      `INSERT INTO public.password_reset_otps (user_id, otp_hash, email, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [user.id, sha256(otp), cleanEmail, minutesFromNow(5)]
    );

    log.info("send-password-reset-otp.code_stored", { email: cleanEmail, user_id: user.id });
    try {
      await sendMail({
        to: email,
        subject: "Reset Your Password - SimpleLecture",
        text: `Password reset code: ${otp} (expires in 5 minutes)`,
        html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #333; text-align: center;">Password Reset</h1>
          <p style="color: #666; font-size: 16px;">You requested to reset your password. Use the code below to proceed:</p>
          <div style="background-color: #f5f5f5; padding: 20px; text-align: center; margin: 20px 0; border-radius: 8px;">
            <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #333;">${otp}</span>
          </div>
          <p style="color: #999; font-size: 14px;">This code expires in <strong>5 minutes</strong>.</p>
        </div>`,
      });
    } catch (mailErr) {
      log.error("send-password-reset-otp.mail_failed", { email: cleanEmail, error: mailErr, reason: "Reset email could not be sent: mail provider error" });
      return ok({
        error: "We couldn't send the email right now. Please try again in a minute.",
        code: "EMAIL_SEND_FAILED",
      });
    }

    return ok({ message: GENERIC });
  } catch (e) {
    log.error("send-password-reset-otp.exception", { error: e, reason: "Server error while sending the reset code (see server log)" });
    return ok({ error: "Something went wrong on our end. Please try again.", code: "INTERNAL_ERROR" });
  }
}));
