// Port of Supabase Auth POST /auth/v1/token?grant_type=password|refresh_token.
import bcrypt from "bcryptjs";
import { log } from "../_shared/log.js";
import express from "express";
import { query } from "../_shared/db.js";
import { issueSession } from "../_shared/session.js";

const INVALID = { error: "invalid_grant", error_description: "Invalid login credentials" };

export const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const grant = req.query.grant_type || req.body?.grant_type;

    if (grant === "password") {
      const email = String(req.body?.email || "").toLowerCase().trim();
      const password = String(req.body?.password || "");
      const { rows } = await query("SELECT * FROM auth.users WHERE lower(email) = $1 LIMIT 1", [email]);
      const user = rows[0];
      if (!user) log.warn("auth-token.password.no_account", { email, reason: "No account exists for this email" });
      if (!user?.encrypted_password || !user.encrypted_password.startsWith("$2")) {
        return res.status(400).json(INVALID);
      }
      if (!(await bcrypt.compare(password, user.encrypted_password))) {
        log.warn("auth-token.password.wrong_password", { email, user_id: user.id, reason: "Wrong password entered" });
        return res.status(400).json(INVALID);
      }
      log.info("auth-token.password.ok", { email, user_id: user.id });
      return res.json(await issueSession(user));
    }

    if (grant === "refresh_token") {
      const rt = String(req.body?.refresh_token || "");
      const { rows } = await query(
        `SELECT s.id AS session_id, u.* FROM public.auth_refresh_tokens s
           JOIN auth.users u ON u.id = s.user_id
          WHERE s.refresh_token = $1 AND s.expires_at > now() LIMIT 1`,
        [rt]
      );
      if (!rows[0]) {
        log.warn("auth-token.refresh.invalid_token", { reason: "Refresh token is invalid, expired or already used" });
        return res.status(400).json({ error: "invalid_grant", error_description: "Invalid Refresh Token" });
      }
      log.info("auth-token.refresh.ok", { user_id: rows[0].id, email: rows[0].email });
      // Rotate: the old refresh token is single-use.
      await query("DELETE FROM public.auth_refresh_tokens WHERE id = $1", [rows[0].session_id]);
      return res.json(await issueSession(rows[0]));
    }

    return res.status(400).json({ error: "unsupported_grant_type" });
  } catch (e) {
    log.error("auth-token.exception", { error: e, reason: "Server error during login (see server log)" });
    return res.status(500).json({ error: "server_error", error_description: "Internal error" });
  }
});
