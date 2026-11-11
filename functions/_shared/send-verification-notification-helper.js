// Auth helpers shared by the group-05 admin and server-to-server functions.
// Service calls carry SERVICE_ROLE_KEY as the Bearer token. User calls carry a JWT signed with
// JWT_SECRET. If SERVICE_ROLE_KEY is unset, service calls are refused.
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { query } from "./db.js";

export function bearerToken(req) {
  return String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
}

export function isServiceCall(req) {
  const key = process.env.SERVICE_ROLE_KEY;
  const given = bearerToken(req);
  if (!key || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The user id from a valid user JWT, or null.
export function jwtUserId(req) {
  try {
    return jwt.verify(bearerToken(req), process.env.JWT_SECRET).sub || null;
  } catch {
    return null;
  }
}

export async function userHasRole(userId, roles) {
  const { rows } = await query(
    "SELECT 1 FROM public.user_roles WHERE user_id = $1 AND role = ANY($2::app_role[]) LIMIT 1",
    [userId, roles]
  );
  return rows.length > 0;
}
