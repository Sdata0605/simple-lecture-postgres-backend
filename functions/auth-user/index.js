// Port of Supabase Auth GET /auth/v1/user: returns the user for the bearer token.
import express from "express";
import { log } from "../_shared/log.js";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";
import { toAuthUser } from "../_shared/session.js";

export const router = express.Router();

router.get("/", async (req, res) => {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "no_authorization", error_description: "No API key found in request" });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await query("SELECT * FROM auth.users WHERE id = $1", [payload.sub]);
    if (!rows[0]) return res.status(401).json({ error: "user_not_found" });
    return res.json(toAuthUser(rows[0]));
  } catch (e) {
    log.warn("auth-user.bad_token", { reason: e.message });
    return res.status(401).json({ error: "bad_jwt", error_description: "invalid JWT" });
  }
});
