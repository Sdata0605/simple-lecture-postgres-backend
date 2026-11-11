// Port of Supabase Auth POST /auth/v1/logout: ends the session for the given refresh token.
import express from "express";
import { log } from "../_shared/log.js";
import { query } from "../_shared/db.js";

export const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const rt = req.body?.refresh_token;
    log.info("auth-logout.request", { had_token: !!rt });
    if (rt) await query("DELETE FROM public.auth_refresh_tokens WHERE refresh_token = $1", [rt]);
    return res.status(204).end();
  } catch (e) {
    log.error("auth-logout.exception", { error: e });
    return res.status(500).json({ error: "server_error" });
  }
});
