// Port of supabase/functions/verify-phone-otp. On success it returns a session, as the original did.
// Signup creates the account via _shared/accounts.js (the migrated DB has no profile trigger).
import express from "express";
import { log } from "../_shared/log.js";
import { query, lockedBy } from "../_shared/db.js";
import { sha256 } from "../_shared/otp.js";
import { createAuthUser } from "../_shared/accounts.js";
import { issueSession } from "../_shared/session.js";

const fail = (res, status, error) => {
  log.warn("verify-phone-otp.rejected", { status, reason: error });
  return res.status(status).json({ error });
};

export const router = express.Router();

// POST /functions/v1/verify-phone-otp  { phone, otp_code, purpose, signup_data? }
router.post("/", lockedBy((req) => "phone:" + String(req.body?.phone || "").replace(/\D/g, ""), async (req, res) => {
  try {
    const { phone, otp_code, purpose, signup_data } = req.body || {};
    if (!phone || !otp_code || !purpose) return fail(res, 400, "Phone, OTP code, and purpose are required");
    if (typeof phone !== "string" || typeof purpose !== "string") return fail(res, 400, "Phone and purpose must be text");
    const cleanPhone = String(phone).replace(/\D/g, "");

    const { rows: found } = await query(
      `SELECT * FROM public.phone_otp_verifications
        WHERE phone_number = $1 AND purpose = $2 AND verified = false AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1`,
      [cleanPhone, purpose]
    );
    const otpRecord = found[0];
    if (!otpRecord) return fail(res, 400, "OTP expired or not found. Please request a new one.");
    log.info("verify-phone-otp.record_found", { phone: cleanPhone, purpose, otp_id: otpRecord.id, attempts: otpRecord.attempts, channel: otpRecord.channel });

    if (otpRecord.attempts >= 3) {
      await query("UPDATE public.phone_otp_verifications SET verified = true WHERE id = $1", [otpRecord.id]);
      return fail(res, 429, "Too many incorrect attempts. Please request a new OTP.");
    }

    if (sha256(String(otp_code)) !== otpRecord.otp_hash) {
      log.warn("verify-phone-otp.wrong_code", { phone: cleanPhone, otp_id: otpRecord.id, attempts_before: otpRecord.attempts, channel: otpRecord.channel, reason: "Wrong OTP code entered" });
      await query("UPDATE public.phone_otp_verifications SET attempts = attempts + 1 WHERE id = $1", [otpRecord.id]);
      const remaining = 2 - otpRecord.attempts;
      return fail(
        res,
        401,
        `Incorrect OTP. ${remaining > 0 ? `${remaining} attempt(s) remaining.` : "Please request a new OTP."}`
      );
    }

    // Signup pre-flight runs BEFORE the OTP is consumed, as in the original.
    if (purpose !== "login") {
      if (!signup_data?.full_name || !signup_data?.email) {
        return fail(res, 400, "Full name and email are required for signup");
      }
      const cleanEmail = String(signup_data.email).toLowerCase().trim();

      const { rows: dupEmail } = await query("SELECT id FROM public.profiles WHERE email = $1 LIMIT 1", [cleanEmail]);
      if (dupEmail.length) return fail(res, 409, "An account with this email already exists.");

      const { rows: dupPhone } = await query(
        "SELECT id FROM public.profiles WHERE phone_number = $1 LIMIT 1",
        [cleanPhone]
      );
      if (dupPhone.length) {
        return fail(res, 409, "An account with this phone number already exists. Please log in instead.");
      }
    }

    await query("UPDATE public.phone_otp_verifications SET verified = true WHERE id = $1", [otpRecord.id]);

    log.info("verify-phone-otp.code_consumed", { phone: cleanPhone, purpose, otp_id: otpRecord.id, channel: otpRecord.channel });
    let user;
    if (purpose === "login") {
      const { rows } = await query(
        `SELECT u.* FROM public.profiles p JOIN auth.users u ON u.id = p.id
          WHERE p.phone_number = $1 ORDER BY p.created_at DESC LIMIT 1`,
        [cleanPhone]
      );
      if (!rows[0]) return fail(res, 404, "User not found");
      user = rows[0];
    } else {
      user = await createAuthUser({
        email: String(signup_data.email).toLowerCase().trim(),
        fullName: signup_data.full_name,
        phone: cleanPhone,
      });
    }
    log.info(purpose === "login" ? "verify-phone-otp.login_user" : "verify-phone-otp.account_created", { phone: cleanPhone, user_id: user.id, email: user.email });
    const session = await issueSession(user);
    log.info("verify-phone-otp.session_issued", { phone: cleanPhone, user_id: user.id, channel: otpRecord.channel });
    return res.json({
      success: true,
      session: { access_token: session.access_token, refresh_token: session.refresh_token },
      user: { id: user.id, email: user.email },
    });
  } catch (e) {
    if (e.code === "user_already_exists") {
      log.error("verify-phone-otp.account_conflict", { error: e, note: "pg error behind the 409 message" });
      return fail(res, 409, "An account with this email already exists.");
    }
    log.error("verify-phone-otp.exception", { error: e, reason: "Server error while verifying the code (see server log)" });
    return fail(res, 500, "Internal server error");
  }
}));
