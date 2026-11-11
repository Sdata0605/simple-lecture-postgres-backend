// Auth and account helpers shared by the group-02 admin, service and cron functions.
// Ported from the inline checks in the Supabase functions. Tokens and secrets are never logged.
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { query, pool } from "./db.js";

// The signed-in user's id from `Authorization: Bearer <jwt>`, or null.
export function userIdFromBearer(req) {
  const h = String(req.headers.authorization || "");
  if (!h.startsWith("Bearer ")) return null;
  try {
    const sub = jwt.verify(h.slice(7).trim(), process.env.JWT_SECRET).sub;
    return typeof sub === "string" && sub ? sub : null;
  } catch {
    return null;
  }
}

export async function isAdminUser(userId) {
  const { rows } = await query("SELECT 1 FROM public.user_roles WHERE user_id = $1 AND role = 'admin' LIMIT 1", [userId]);
  return rows.length > 0;
}

// Constant-time comparison of a secret from a request with the configured value.
export function sameSecret(given, expected) {
  if (typeof given !== "string" || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Service-role-only functions: caller sends x-service-key = INTERNAL_SERVICE_KEY.
export const serviceKeyOk = (req) => sameSecret(req.headers["x-service-key"], process.env.INTERNAL_SERVICE_KEY);

// Cron-only functions: caller sends x-cron-key = the named env value. Unset env fails closed.
export const cronKeyOk = (req, envName) => sameSecret(req.headers["x-cron-key"], process.env[envName]);

export async function findAuthUserIdByEmail(email) {
  const { rows } = await query("SELECT id FROM auth.users WHERE lower(email) = lower($1) LIMIT 1", [email]);
  return rows[0]?.id ?? null;
}

// Creates a confirmed auth user. Returns the new id.
export async function createConfirmedUser({ email, password, fullName }) {
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await query(
    `INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, now(), $3::jsonb, now(), now())
     RETURNING id`,
    [email, hash, JSON.stringify({ full_name: fullName })]
  );
  return rows[0].id;
}

export async function setPasswordAndConfirm(userId, password) {
  const hash = await bcrypt.hash(password, 10);
  await query(
    `UPDATE auth.users SET encrypted_password = $2, email_confirmed_at = COALESCE(email_confirmed_at, now()), updated_at = now()
      WHERE id = $1`,
    [userId, hash]
  );
}

export async function upsertProfile(userId, fullName, email) {
  await query(
    `INSERT INTO public.profiles (id, full_name, email) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, email = EXCLUDED.email`,
    [userId, fullName, email]
  );
}

export async function ensureRole(userId, role) {
  await query(
    `INSERT INTO public.user_roles (user_id, role)
     SELECT $1, $2::app_role
      WHERE NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = $1 AND role = $2::app_role)`,
    [userId, role]
  );
}

// Gives a student an active course enrolment for 365 days (updates an existing row).
export async function grantCourseFor365Days(studentId, courseId) {
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const upd = await query(
    "UPDATE public.enrollments SET is_active = true, expires_at = $3 WHERE student_id = $1 AND course_id = $2",
    [studentId, courseId, expires]
  );
  if (upd.rowCount === 0) {
    await query(
      `INSERT INTO public.enrollments (student_id, course_id, is_active, enrolled_at, expires_at)
       VALUES ($1, $2, true, now(), $3)`,
      [studentId, courseId, expires]
    );
  }
}

// Removes an auth user created by a failed request (the equivalent of admin.deleteUser).
export async function deleteAuthUserQuietly(userId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM public.user_roles WHERE user_id = $1", [userId]);
    await client.query("DELETE FROM public.profiles WHERE id = $1", [userId]);
    await client.query("DELETE FROM auth.users WHERE id = $1", [userId]);
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => {});
  } finally {
    client.release();
  }
}
