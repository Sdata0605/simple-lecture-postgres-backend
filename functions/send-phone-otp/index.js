// Port of supabase/functions/send-phone-otp. Same validation, status codes, rate limit and expiry.
import express from "express";
import { log } from "../_shared/log.js";
import { query, lockedBy } from "../_shared/db.js";
import { generateOtp, sha256, minutesFromNow } from "../_shared/otp.js";
import { sendSmsOtp, sendWhatsappOtp } from "../_shared/sms.js";

const fail = (res, status, error) => {
  log.warn("send-phone-otp.rejected", { status, reason: error });
  return res.status(status).json({ error });
};

export const router = express.Router();

// POST /functions/v1/send-phone-otp  { phone, purpose: 'login' | 'signup', channel?: 'sms' | 'whatsapp' }
router.post("/", lockedBy((req) => "phone:" + String(req.body?.phone || "").replace(/\D/g, ""), async (req, res) => {
  try {
    const { phone, purpose, channel = "sms" } = req.body || {};
    if (!phone || !purpose) return fail(res, 400, "Phone and purpose are required");
    if (typeof phone !== "string" || typeof purpose !== "string") return fail(res, 400, "Phone and purpose must be text");
    if (!["login", "signup"].includes(purpose)) return fail(res, 400, "Purpose must be login or signup");
    if (!["sms", "whatsapp"].includes(channel)) return fail(res, 400, "Channel must be sms or whatsapp");

    const cleanPhone = String(phone).replace(/\D/g, "");
    if (cleanPhone.length !== 10) return fail(res, 400, "Invalid phone number. Must be 10 digits.");

    const { rows: profiles } = await query(
      `SELECT id, phone_number, full_name FROM public.profiles
        WHERE phone_number = $1 ORDER BY created_at DESC LIMIT 1`,
      [cleanPhone]
    );
    const profile = profiles[0] ?? null;

    if (purpose === "login" && !profile) {
      return fail(res, 404, "No account found with this phone number. Please sign up first.");
    }
    if (purpose === "signup" && profile) {
      return fail(res, 409, "An account with this phone number already exists. Please login instead.");
    }

    // Rate limit: max 3 OTPs per phone per 10 minutes.
    const { rows: recent } = await query(
      `SELECT count(*)::int AS n FROM public.phone_otp_verifications
        WHERE phone_number = $1 AND created_at >= now() - interval '10 minutes'`,
      [cleanPhone]
    );
    if ((recent[0]?.n ?? 0) >= 3) return fail(res, 429, "Too many OTP requests. Please wait 10 minutes.");

    log.info("send-phone-otp.checks_passed", { phone: cleanPhone, purpose, channel, recent_otps: recent[0]?.n ?? 0 });
    const otp = generateOtp();
    await query(
      `INSERT INTO public.phone_otp_verifications (phone_number, otp_hash, purpose, expires_at, channel)
       VALUES ($1, $2, $3, $4, $5)`,
      [cleanPhone, sha256(otp), purpose, minutesFromNow(5), channel]
    );

    const delivery =
      channel === "whatsapp"
        ? await sendWhatsappOtp({ cleanPhone, otp, purpose })
        : await sendSmsOtp({ cleanPhone, otp, purpose, userName: profile?.full_name || "User" });
    if (!delivery.ok) {
      log.error("send-phone-otp.delivery_failed", { phone: cleanPhone, channel, reason: delivery.error });
      return res.status(502).json({ error: delivery.error });
    }
    log.info("send-phone-otp.sent", { phone: cleanPhone, purpose, channel, dry_run: !!delivery.dryRun });

    return res.json({
      success: true,
      message: `OTP sent successfully via ${channel}`,
      phone: cleanPhone.slice(-4),
      channel,
    });
  } catch (e) {
    log.error("send-phone-otp.exception", { error: e, reason: "OTP could not be sent: server error (see server log)" });
    return fail(res, 500, "Internal server error");
  }
}));
