// Not a test: run with `node test/cleanup.js` to delete every account the tests created (example.test).
import "dotenv/config";
import { pool } from "../functions/_shared/db.js";
if (!/simplelecture_test/.test(process.env.DATABASE_URL || "")) {
  throw new Error("Refusing to clean: DATABASE_URL must point at simplelecture_test");
}
const { rows } = await pool.query("SELECT id FROM auth.users WHERE email LIKE '%@example.test'");
const ids = rows.map((r) => r.id);
if (ids.length) {
  await pool.query("DELETE FROM public.auth_refresh_tokens WHERE user_id = ANY($1)", [ids]);
  await pool.query("DELETE FROM public.password_reset_otps WHERE user_id = ANY($1)", [ids]);
  await pool.query("DELETE FROM public.user_roles WHERE user_id = ANY($1)", [ids]);
  await pool.query("DELETE FROM public.profiles WHERE id = ANY($1)", [ids]);
  await pool.query("DELETE FROM auth.users WHERE id = ANY($1)", [ids]);
}
await pool.query("DELETE FROM public.email_otp_verifications WHERE email LIKE '%@example.test'");
console.log(`removed ${ids.length} test accounts`);
await pool.end();
