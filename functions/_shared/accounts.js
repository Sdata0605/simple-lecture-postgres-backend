// Account creation. Supabase's on_auth_user_created trigger (handle_new_user) normally creates the
// profile and 'student' role row. The inserts below skip rows that already exist, so this works
// whether or not that trigger is present (the server copy has no trigger).
import bcrypt from "bcryptjs";
import { log } from "../_shared/log.js";
import crypto from "node:crypto";
import { pool } from "./db.js";

const RANDOM_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%";
export function randomPassword() {
  let out = "";
  for (let i = 0; i < 24; i++) out += RANDOM_CHARS.charAt(crypto.randomInt(RANDOM_CHARS.length));
  return out;
}

// { email, password?, fullName, phone? } -> the new auth.users row.
// Throws with err.code = 'user_already_exists' on a duplicate email.
export async function createAuthUser({ email, password, fullName, phone }) {
  const hash = await bcrypt.hash(password || randomPassword(), 10);
  const meta = { full_name: fullName ?? null, phone: phone ?? null };
  const digits = phone ? String(phone).replace(/\D/g, "") || null : null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, now(), $3::jsonb, now(), now())
       RETURNING *`,
      [email, hash, JSON.stringify(meta)]
    );
    const user = rows[0];
    await client.query(
      `INSERT INTO public.profiles (id, full_name, email, phone_number) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [user.id, fullName ?? null, email, digits]
    );
    await client.query(
      `INSERT INTO public.user_roles (user_id, role) SELECT $1, 'student'
        WHERE NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = $1 AND role = 'student')`,
      [user.id]
    );
    await client.query("COMMIT");
    log.info("accounts.created", { email, user_id: user.id, phone: digits });
    return user;
  } catch (e) {
    await client.query("ROLLBACK");
    log.error("accounts.failed", { email, error: e });
    if (e.code === "23505") {
      log.error("accounts.unique_conflict", { email, phone, error: e });
      // The unique constraint name tells email and phone conflicts apart.
      const isPhone = /phone/i.test(e.constraint || "");
      const dup = new Error(isPhone
        ? "An account with this phone number already exists."
        : "A user with this email address has already been registered");
      dup.code = isPhone ? "phone_already_exists" : "user_already_exists";
      throw dup;
    }
    throw e;
  } finally {
    client.release();
  }
}
