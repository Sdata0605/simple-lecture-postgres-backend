// Port of supabase/functions/api. Public read API for courses, subjects, instructors, categories,
// and the signed-in student's enrollments. Mount at /api/v1 (routes below are relative to that).
// Embedded relations that PostgREST used to return are built with json_agg subqueries.
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";

export const router = express.Router();

const toInt = (v, fallback) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const errorOut = (res, e) => res.status(500).json({ error: e instanceof Error ? e.message : "Unknown error" });

// GET /courses/:id : one active course with its categories, subjects, instructors, and FAQs
// GET /courses      : paginated active courses (?page, ?limit, ?category=<slug>)
router.get("/courses/:id", async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT c.*,
         COALESCE((SELECT json_agg(json_build_object('category', to_jsonb(cat)))
                     FROM public.course_categories cc JOIN public.categories cat ON cat.id = cc.category_id
                    WHERE cc.course_id = c.id), '[]'::json) AS categories,
         COALESCE((SELECT json_agg(json_build_object('subject', to_jsonb(ps)) ORDER BY cs.display_order)
                     FROM public.course_subjects cs JOIN public.popular_subjects ps ON ps.id = cs.subject_id
                    WHERE cs.course_id = c.id), '[]'::json) AS subjects,
         COALESCE((SELECT json_agg(json_build_object('instructor', to_jsonb(tp)))
                     FROM public.course_teachers ct JOIN public.teacher_profiles tp ON tp.id = ct.teacher_id
                    WHERE ct.course_id = c.id), '[]'::json) AS instructors,
         COALESCE((SELECT json_agg(to_jsonb(f) ORDER BY f.display_order)
                     FROM public.course_faqs f WHERE f.course_id = c.id), '[]'::json) AS faqs
       FROM public.courses c
       WHERE c.id = $1 AND c.is_active = true`,
      [req.params.id]
    );
    if (rows.length === 0) throw new Error("Course not found");
    return res.json(rows[0]);
  } catch (e) {
    return errorOut(res, e);
  }
});

router.get("/courses", async (req, res) => {
  try {
    const page = toInt(req.query.page, 1);
    const limit = toInt(req.query.limit, 20);
    const category = typeof req.query.category === "string" ? req.query.category : "";
    const offset = (page - 1) * limit;

    const params = [];
    let where = "c.is_active = true";
    if (category) {
      params.push(category);
      where += ` AND EXISTS (SELECT 1 FROM public.course_categories cc
                              JOIN public.categories cat ON cat.id = cc.category_id
                             WHERE cc.course_id = c.id AND cat.slug = $${params.length})`;
    }

    const { rows: countRows } = await query(`SELECT COUNT(*)::int AS total FROM public.courses c WHERE ${where}`, params);
    params.push(limit, offset);
    const { rows } = await query(
      `SELECT c.*,
         COALESCE((SELECT json_agg(json_build_object('category', to_jsonb(cat)))
                     FROM public.course_categories cc JOIN public.categories cat ON cat.id = cc.category_id
                    WHERE cc.course_id = c.id), '[]'::json) AS categories
       FROM public.courses c
       WHERE ${where}
       ORDER BY c.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const total = countRows[0].total;
    return res.json({ data: rows, page, limit, total, totalPages: Math.ceil(total / limit) });
  } catch (e) {
    return errorOut(res, e);
  }
});

router.get("/subjects", async (_req, res) => {
  try {
    const { rows } = await query("SELECT * FROM public.popular_subjects WHERE is_active = true ORDER BY display_order");
    return res.json(rows);
  } catch (e) {
    return errorOut(res, e);
  }
});

router.get("/instructors", async (_req, res) => {
  try {
    // The original filtered on teacher_profiles.is_active, a column this schema does not have,
    // so that filter is not applied here.
    const { rows } = await query(
      `SELECT tp.*,
         COALESCE((SELECT json_agg(json_build_object('subject', to_jsonb(ps)))
                     FROM public.instructor_subjects isb JOIN public.popular_subjects ps ON ps.id = isb.subject_id
                    WHERE isb.instructor_id = tp.id), '[]'::json) AS subjects
       FROM public.teacher_profiles tp`
    );
    return res.json(rows);
  } catch (e) {
    return errorOut(res, e);
  }
});

router.get("/categories", async (_req, res) => {
  try {
    const { rows } = await query("SELECT * FROM public.categories WHERE is_active = true ORDER BY display_order");
    return res.json(rows);
  } catch (e) {
    return errorOut(res, e);
  }
});

router.get("/student/enrollments", async (req, res) => {
  const header = req.headers.authorization;
  let userId = null;
  if (header) {
    try {
      userId = jwt.verify(String(header).replace(/^Bearer\s+/i, "").trim(), process.env.JWT_SECRET)?.sub || null;
    } catch {
      userId = null;
    }
  }
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const { rows } = await query(
      `SELECT e.*,
         (SELECT to_jsonb(c) FROM public.courses c WHERE c.id = e.course_id) AS course,
         (SELECT to_jsonb(b) FROM public.batches b WHERE b.id = e.batch_id) AS batch
       FROM public.enrollments e
       WHERE e.student_id = $1 AND e.is_active = true`,
      [userId]
    );
    return res.json(rows);
  } catch (e) {
    return errorOut(res, e);
  }
});

router.use((_req, res) => res.status(404).json({ error: "Not found" }));
