// Port of supabase/functions/update-instructor-password. Admin tool: sets the login password of an
// instructor's linked account. POST { instructorId, newPassword }.
// Caller: an admin JWT (role admin) or the service key. The original relied on the gateway JWT only,
// so any signed-in user could reset any instructor; this port requires the admin role.
import express from "express";
import bcrypt from "bcryptjs";
import { query } from "../_shared/db.js";
import { isServiceCall, jwtUserId, userHasRole } from "../_shared/send-verification-notification-helper.js";

export const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_PASSWORD = 6;

router.post("/", async (req, res) => {
  try {
    if (!isServiceCall(req)) {
      const userId = jwtUserId(req);
      if (!userId || !(await userHasRole(userId, ["admin"]))) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    const { instructorId, newPassword } = req.body || {};
    console.log("Updating password for instructor:", instructorId);

    const notFound = () => res.status(404).json({ error: "Instructor not found" });
    if (!UUID_RE.test(String(instructorId ?? ""))) return notFound();

    const { rows } = await query("SELECT user_id, email FROM public.teacher_profiles WHERE id = $1", [instructorId]);
    const instructor = rows[0];
    if (!instructor) return notFound();

    if (!instructor.user_id) {
      console.error("Instructor has no user_id");
      return res.status(400).json({ error: "Instructor account not linked to authentication system" });
    }

    if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD) {
      return res.status(400).json({ error: `Password should be at least ${MIN_PASSWORD} characters.` });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    const updated = await query(
      "UPDATE auth.users SET encrypted_password = $1, updated_at = now() WHERE id = $2 RETURNING id",
      [hash, instructor.user_id]
    );
    if (updated.rowCount === 0) {
      return res.status(400).json({ error: "User not found" });
    }

    console.log("Password updated successfully for instructor");
    return res.status(200).json({ success: true, message: "Password updated successfully" });
  } catch (error) {
    console.error("Error in update-instructor-password function:", error?.message);
    return res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

export default router;
