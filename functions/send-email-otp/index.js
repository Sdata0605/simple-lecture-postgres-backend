// Port of supabase/functions/send-email-otp. Same status codes, messages, rate limit and expiry.
import express from "express";
import { log } from "../_shared/log.js";
import { query, lockedBy } from "../_shared/db.js";
import { generateOtp, sha256, minutesFromNow } from "../_shared/otp.js";
import { sendMail } from "../_shared/mail.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const fail = (res, status, error) => {
  log.warn("send-email-otp.rejected", { status, reason: error, email: res.req?.body?.email });
  return res.status(status).json({ error });
};
const mask = (email) => {
  const [local, domain] = email.split("@");
  return local.substring(0, 2) + "***@" + domain;
};

export const router = express.Router();

// POST /functions/v1/send-email-otp  { email, purpose: 'login' | 'signup' }
router.post("/", lockedBy((req) => "email:" + String(req.body?.email || "").toLowerCase().trim(), async (req, res) => {
  try {
    const { email, purpose } = req.body || {};
    if (!email || !purpose) return fail(res, 400, "Email and purpose are required");
    if (typeof email !== "string" || typeof purpose !== "string") return fail(res, 400, "Email and purpose must be text");
    if (!["login", "signup"].includes(purpose)) return fail(res, 400, "Purpose must be login or signup");
    if (!EMAIL_RE.test(email) || email.length > 254) return fail(res, 400, "Invalid email format");

    const cleanEmail = email.toLowerCase().trim();

    const { rows: existing } = await query("SELECT id FROM public.profiles WHERE email = $1 LIMIT 1", [cleanEmail]);
    const userExists = existing.length > 0;
    if (purpose === "login" && !userExists) {
      return fail(res, 404, "No account found with this email. Please sign up first.");
    }
    if (purpose === "signup" && userExists) {
      return fail(res, 409, "An account with this email already exists. Please login instead.");
    }

    // Rate limit: max 3 OTPs per email per 10 minutes.
    const { rows: recent } = await query(
      `SELECT count(*)::int AS n FROM public.email_otp_verifications
        WHERE email = $1 AND created_at >= now() - interval '10 minutes'`,
      [cleanEmail]
    );
    if ((recent[0]?.n ?? 0) >= 3) return fail(res, 429, "Too many OTP requests. Please wait 10 minutes.");

    log.info("send-email-otp.checks_passed", { email: cleanEmail, purpose, recent_otps: recent[0]?.n ?? 0 });
    const otp = generateOtp();
    await query(
      `INSERT INTO public.email_otp_verifications (email, otp_hash, purpose, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [cleanEmail, sha256(otp), purpose, minutesFromNow(5)]
    );

    log.info("send-email-otp.code_stored", { email: cleanEmail, purpose, expires_in_minutes: 5 });
    const isLogin = purpose === "login";
    const heading = isLogin ? "Login Verification" : "Email Verification";
    const description = isLogin
      ? "Use the code below to log in to your SimpleLecture account:"
      : "Use the code below to verify your email and create your SimpleLecture account:";
    await sendMail({
      to: cleanEmail,
      subject: isLogin ? "Your Login OTP - SimpleLecture" : "Verify Your Email - SimpleLecture",
      text: `${heading}: ${otp} (expires in 5 minutes)`,
      html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h1 style="color: #333; text-align: center;">${heading}</h1>
        <p style="color: #666; font-size: 16px;">${description}</p>
        <div style="background-color: #f5f5f5; padding: 20px; text-align: center; margin: 20px 0; border-radius: 8px;">
          <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #333;">${otp}</span>
        </div>
        <p style="color: #999; font-size: 14px;">This code expires in <strong>5 minutes</strong>.</p>
      </div>`,
    });

    log.info("send-email-otp.sent", { email: cleanEmail, purpose });
    return res.json({ success: true, message: "OTP sent successfully", email: mask(cleanEmail) });
  } catch (e) {
    log.error("send-email-otp.exception", { error: e, reason: "Email OTP could not be sent: server or mail provider error (see server log)" });
    return fail(res, 500, "Internal server error");
  }
}));
