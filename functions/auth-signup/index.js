// Port of Supabase Auth POST /auth/v1/signup (email + password).
import express from "express";
import { log } from "../_shared/log.js";
import { createAuthUser } from "../_shared/accounts.js";
import { issueSession } from "../_shared/session.js";

export const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post("/", async (req, res) => {
  try {
    const email = String(req.body?.email || "").toLowerCase().trim();
    const password = String(req.body?.password || "");
    const data = req.body?.data || req.body?.user_metadata || {};
    if (!email || !password) {
      return res.status(400).json({ error: "validation_failed", error_description: "Email and password are required" });
    }
    // Same format rule as send-email-otp, plus the 254-character limit (RFC 5321).
    if (!EMAIL_RE.test(email) || email.length > 254) {
      return res.status(400).json({ error: "validation_failed", error_description: "Invalid email format" });
    }
    if (password.length < 6) {
      return res.status(422).json({ error: "weak_password", error_description: "Password should be at least 6 characters." });
    }

    log.info("auth-signup.start", { email });
    const user = await createAuthUser({
      email,
      password,
      fullName: data.full_name,
      phone: data.phone,
    });
    return res.json(await issueSession(user));
  } catch (e) {
    if (e.code === "user_already_exists" || e.code === "phone_already_exists") {
      log.warn("auth-signup.conflict", { code: e.code, status: 422, reason: e.code === "phone_already_exists" ? "Phone number already has an account" : "An account with this email already exists" });
      return res.status(422).json({ error: e.code, error_description: e.message });
    }
    log.error("auth-signup.exception", { error: e, reason: "Server error while creating the account (see server log)" });
    return res.status(500).json({ error: "server_error", error_description: "Internal error" });
  }
});
