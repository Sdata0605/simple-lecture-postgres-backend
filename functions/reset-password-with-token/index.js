// Port of supabase/functions/reset-password-with-token.
// Supabase stored passwords as bcrypt; bcryptjs produces the same $2a/$2b format.
import bcrypt from "bcryptjs";
import { log } from "../_shared/log.js";
import express from "express";
import { query, lockedBy } from "../_shared/db.js";
import { sha256 } from "../_shared/otp.js";

const ok = (res, body) => {
  log.info("reset-password-with-token.reply", { result: body.error ? body.code : "ok", user_id: body.user_id });
  return res.status(200).json(body);
};
const TOKEN_MAX_AGE_MS = 10 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const router = express.Router();

// POST /functions/v1/reset-password-with-token  { reset_token, new_password, user_id }
router.post("/", lockedBy((req) => "reset-user:" + String(req.body?.user_id || ""), async (req, res) => {
  try {
    const { reset_token, new_password, user_id } = req.body || {};
    if (!reset_token || !new_password || !user_id || !UUID_RE.test(String(user_id))) {
      return ok(res, { error: "Your reset session expired. Please start over.", code: "SESSION_EXPIRED" });
    }
    if (String(new_password).length < 6) {
      return ok(res, { error: "Please choose a password with at least 6 characters.", code: "WEAK_PASSWORD" });
    }

    const { rows: found } = await query(
      `SELECT * FROM public.password_reset_otps
        WHERE user_id = $1 AND otp_hash = $2 AND verified = true
        ORDER BY created_at DESC LIMIT 1`,
      [user_id, sha256(String(reset_token))]
    );
    const otpRecord = found[0];
    if (!otpRecord) {
      return ok(res, { error: "Your reset session expired. Please start over.", code: "SESSION_EXPIRED" });
    }

    if (Date.now() - new Date(otpRecord.created_at).getTime() > TOKEN_MAX_AGE_MS) {
      await query("DELETE FROM public.password_reset_otps WHERE id = $1", [otpRecord.id]);
      return ok(res, { error: "Your reset session expired. Please start over.", code: "SESSION_EXPIRED" });
    }

    log.info("reset-password-with-token.token_valid", { user_id });
    const hash = await bcrypt.hash(String(new_password), 10);
    const { rowCount } = await query(
      "UPDATE auth.users SET encrypted_password = $1, updated_at = now() WHERE id = $2",
      [hash, user_id]
    );
    if (rowCount === 0) {
      return ok(res, { error: "We couldn't update your password. Please try again.", code: "INTERNAL_ERROR" });
    }

    await query("DELETE FROM public.password_reset_otps WHERE user_id = $1", [user_id]);
    return ok(res, { message: "Password reset successfully" });
  } catch (e) {
    log.error("reset-password-with-token.exception", { error: e });
    return ok(res, { error: "Something went wrong on our end. Please try again.", code: "INTERNAL_ERROR" });
  }
}));
