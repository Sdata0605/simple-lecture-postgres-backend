// Port of supabase/functions/enroll-free-course. Enrols the signed-in student in a free, active course.
// POST { courseId } with the student's access token.
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";

export const router = express.Router();

router.post("/", async (req, res) => {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!req.headers.authorization?.startsWith("Bearer ") || !token) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  let userId;
  try {
    userId = jwt.verify(token, process.env.JWT_SECRET).sub;
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const courseId = String(req.body?.courseId || "");
  if (!courseId) return res.status(400).json({ error: "courseId required" });

  try {
    const { rows } = await query("SELECT id, price_inr, is_active FROM public.courses WHERE id = $1", [courseId]);
    const course = rows[0];
    if (!course) return res.status(404).json({ error: "Course not found" });
    if (!course.is_active) return res.status(400).json({ error: "Course is not active" });
    if ((course.price_inr ?? 0) > 0) return res.status(403).json({ error: "This course is not free" });

    await query(
      `INSERT INTO public.enrollments (student_id, course_id, is_active)
       VALUES ($1, $2, true)
       ON CONFLICT (student_id, course_id) DO UPDATE SET is_active = true`,
      [userId, courseId]
    );
    return res.json({ enrolled: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});
