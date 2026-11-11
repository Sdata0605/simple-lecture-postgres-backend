// Port of supabase/functions/homepage-data. One request returns everything the homepage needs:
// category tree, courses, featured sections, explore-by-goal tiles and hero video settings.
// Public read. GET or POST. ?ping=true is a warm-up check that touches nothing.
// Base64 icons are replaced with null (the UI shows a fallback emoji).
// The original ran as the caller's anon client, so row-level security applied. This port checks
// the courses.restricted_to_user_id rule directly: restricted courses are shown only to that user.
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";

export const router = express.Router();

const CACHE_HEADERS = { "Cache-Control": "private, no-store", Vary: "Authorization" };

function callerId(req) {
  const h = req.get("Authorization") || "";
  if (!h.startsWith("Bearer ")) return null;
  try {
    return jwt.verify(h.slice(7), process.env.JWT_SECRET)?.sub ?? null;
  } catch {
    return null;
  }
}

// Helper to sanitize icon fields - removes base64 blobs, keeps emojis/URLs.
function sanitizeIcon(icon) {
  if (!icon) return null;
  if (icon.startsWith("data:image")) return null;
  return icon;
}

// Recursively sanitize icons in the category hierarchy.
function sanitizeCategories(categories) {
  return categories.map((cat) => ({
    ...cat,
    icon: sanitizeIcon(cat.icon),
    subcategories: cat.subcategories ? sanitizeCategories(cat.subcategories) : [],
  }));
}

// Loads the level-1 categories with two levels of children, ordered by display_order.
async function loadCategories() {
  const { rows: top } = await query(
    `SELECT id, name, slug, icon, display_order FROM public.categories
      WHERE level = 1 AND is_active = true ORDER BY display_order ASC`,
  );
  if (!top.length) return [];
  const { rows: children } = await query(
    `SELECT id, name, slug, icon, display_order, parent_id FROM public.categories
      WHERE parent_id = ANY($1::uuid[]) ORDER BY display_order ASC`,
    [top.map((t) => t.id)],
  );
  const childIds = children.map((c) => c.id);
  const { rows: grand } = childIds.length
    ? await query(
        `SELECT id, name, slug, icon, display_order, parent_id FROM public.categories
          WHERE parent_id = ANY($1::uuid[]) ORDER BY display_order ASC`,
        [childIds],
      )
    : { rows: [] };

  const strip = ({ parent_id, ...rest }) => rest;
  return top.map((t) => ({
    ...t,
    subcategories: children
      .filter((c) => c.parent_id === t.id)
      .map((c) => ({
        ...strip(c),
        subcategories: grand.filter((g) => g.parent_id === c.id).map(strip),
      })),
  }));
}

const COURSE_COLUMNS = `c.id, c.name, c.slug, c.short_description, c.price_inr, c.original_price_inr,
  c.duration_months, c.student_count, c.rating::float8 AS rating, c.instructor_name, c.is_coming_soon,
  COALESCE((SELECT json_agg(json_build_object('storage_url', t.storage_url))
              FROM public.course_thumbnails t WHERE t.course_id = c.id), '[]'::json) AS course_thumbnails`;

async function loadHomepage(uid) {
  const visible = "(c.restricted_to_user_id IS NULL OR c.restricted_to_user_id = $1::uuid)";
  const [categories, courses, bestsellers, topCourses, mostPopular, goals, hero] = await Promise.all([
    loadCategories(),
    query(
      `SELECT ${COURSE_COLUMNS}, c.is_active FROM public.courses c
        WHERE c.is_active = true AND ${visible}
        ORDER BY c.student_count DESC LIMIT 50`,
      [uid],
    ),
    featured("bestsellers", uid),
    featured("top_courses", uid),
    featured("most_popular", uid),
    query(
      `SELECT id, name, slug, description, display_order, is_active, link_type, link_url, open_in_new_tab
         FROM public.explore_by_goal WHERE is_active = true ORDER BY display_order ASC`,
    ),
    query("SELECT setting_value FROM public.ai_settings WHERE setting_key = 'hero_video' LIMIT 1"),
  ]);

  return {
    categories: sanitizeCategories(categories),
    courses: courses.rows,
    bestsellers,
    topCourses: topCourses,
    mostPopular,
    exploreGoals: goals.rows,
    heroVideoSettings: hero.rows[0]?.setting_value || { enabled: false, youtube_url: "" },
  };
}

// Featured course rows for one section. Rows whose course is missing or hidden are dropped.
async function featured(sectionType, uid) {
  const { rows } = await query(
    `SELECT f.id, f.course_id, f.display_order,
            json_build_object(
              'id', c.id, 'name', c.name, 'slug', c.slug, 'short_description', c.short_description,
              'price_inr', c.price_inr, 'original_price_inr', c.original_price_inr,
              'duration_months', c.duration_months, 'student_count', c.student_count,
              'rating', c.rating, 'instructor_name', c.instructor_name, 'is_coming_soon', c.is_coming_soon,
              'course_thumbnails', COALESCE((SELECT json_agg(json_build_object('storage_url', t.storage_url))
                                              FROM public.course_thumbnails t WHERE t.course_id = c.id), '[]'::json)
            ) AS courses
       FROM public.featured_courses f
       LEFT JOIN public.courses c ON c.id = f.course_id
      WHERE f.section_type = $1 AND f.is_active = true
        AND c.id IS NOT NULL AND c.is_active = true
        AND (c.restricted_to_user_id IS NULL OR c.restricted_to_user_id = $2::uuid)
      ORDER BY f.display_order ASC`,
    [sectionType, uid],
  );
  return rows;
}

router.get("/", async (req, res) => {
  if (req.query.ping === "true") {
    return res.json({ status: "ok", timestamp: Date.now() });
  }
  try {
    const data = await loadHomepage(callerId(req));
    res.set(CACHE_HEADERS).json(data);
  } catch (error) {
    console.error("Homepage data error:", error?.message);
    res.status(500).set(CACHE_HEADERS).json({
      error: error instanceof Error ? error.message : "Failed to fetch homepage data",
    });
  }
});

router.post("/", async (req, res) => {
  try {
    const data = await loadHomepage(callerId(req));
    res.set(CACHE_HEADERS).json(data);
  } catch (error) {
    console.error("Homepage data error:", error?.message);
    res.status(500).set(CACHE_HEADERS).json({
      error: error instanceof Error ? error.message : "Failed to fetch homepage data",
    });
  }
});

router.use((req, res) => {
  res.status(405).type("text/plain").send("Method not allowed");
});
