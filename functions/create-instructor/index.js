// Port of supabase/functions/create-instructor. Admin-only. Creates a confirmed auth user, gives it
// the 'teacher' role and writes its teacher_profiles row. If the role or profile step fails, the
// auth user is removed again. POST { instructorData: { email, full_name, password, ... } }.
// user_id is set to the auth user id too, because update-instructor-password (admin "reset password") needs it.
import express from "express";
import { query } from "../_shared/db.js";
import {
  userIdFromBearer,
  isAdminUser,
  findAuthUserIdByEmail,
  createConfirmedUser,
  deleteAuthUserQuietly,
} from "../_shared/cdn-presentation-refresh-start-helper.js";

export const router = express.Router();

const sendJson = (res, status, body) => res.status(status).type("application/json").send(JSON.stringify(body));

router.post("/", async (req, res) => {
  const userId = userIdFromBearer(req);
  if (!userId) return sendJson(res, 401, { error: "Unauthorized" });
  if (!(await isAdminUser(userId))) return sendJson(res, 403, { error: "Forbidden" });

  const d = req.body?.instructorData;
  if (!d?.email || !d?.full_name || !d?.password) {
    return sendJson(res, 400, { error: "Email, full name, and password are required" });
  }

  let newUserId = null;
  try {
    if (await findAuthUserIdByEmail(d.email)) {
      return sendJson(res, 400, {
        error: "A user with this email address already exists. Please use a different email.",
      });
    }
    newUserId = await createConfirmedUser({ email: d.email, password: d.password, fullName: d.full_name });

    try {
      await query("INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'teacher')", [newUserId]);
      const { rows } = await query(
        `INSERT INTO public.teacher_profiles
           (id, user_id, full_name, email, phone_number, employee_id, date_of_joining, department_id,
            qualification, experience_years, bio, avatar_url)
         VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          newUserId,
          d.full_name,
          d.email,
          d.phone_number || null,
          d.employee_id || null,
          d.date_of_joining || null,
          d.department_id || null,
          d.qualification || null,
          d.experience_years || null,
          d.bio || null,
          d.avatar_url || null,
        ]
      );
      return sendJson(res, 200, { success: true, profile: rows[0] });
    } catch (err) {
      await deleteAuthUserQuietly(newUserId);
      throw err;
    }
  } catch (err) {
    console.error("Error creating instructor:", err.message);
    return sendJson(res, 400, { error: err?.message || "Unknown error occurred" });
  }
});
