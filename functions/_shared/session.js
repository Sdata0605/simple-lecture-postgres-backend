// Session shapes that supabase-js expects, so the UI needs only a base-URL change.
import crypto from "node:crypto";
import { log } from "../_shared/log.js";
import jwt from "jsonwebtoken";
import { query } from "./db.js";

const ACCESS_TTL_SECONDS = 3600;
const REFRESH_TTL_DAYS = 30;

export function toAuthUser(row) {
  return {
    id: row.id,
    aud: "authenticated",
    role: "authenticated",
    email: row.email,
    phone: row.phone ?? "",
    email_confirmed_at: row.email_confirmed_at,
    user_metadata: row.raw_user_meta_data || {},
    app_metadata: row.raw_app_meta_data || { provider: "email", providers: ["email"] },
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_sign_in_at: row.last_sign_in_at,
  };
}

// Issues an access JWT (signed with JWT_SECRET) and a stored refresh token, then returns the session.
export async function issueSession(user) {
  const now = Math.floor(Date.now() / 1000);
  const access_token = jwt.sign(
    { sub: user.id, email: user.email, role: "authenticated", aud: "authenticated" },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TTL_SECONDS }
  );
  const refresh_token = crypto.randomBytes(32).toString("hex");

  await query("UPDATE auth.users SET last_sign_in_at = now() WHERE id = $1", [user.id]);
  await query(
    `INSERT INTO public.auth_refresh_tokens (user_id, refresh_token, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))`,
    [user.id, refresh_token, REFRESH_TTL_DAYS]
  );

  log.info("session.issued", { user_id: user.id, email: user.email });
  const { rows } = await query("SELECT * FROM auth.users WHERE id = $1", [user.id]);
  return {
    access_token,
    token_type: "bearer",
    expires_in: ACCESS_TTL_SECONDS,
    expires_at: now + ACCESS_TTL_SECONDS,
    refresh_token,
    user: toAuthUser(rows[0]),
  };
}
