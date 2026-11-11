// Port of supabase/functions/migrate-course-thumbnails. Admin-only one-off migration: moves base64
// course thumbnails (data:image/...) into the course-thumbnails bucket and records the file in
// public.course_thumbnails (one row per course). Auth: Bearer token of a user with role admin or
// super_admin.
// Note: the original stored permanent public URLs. This server serves files only through signed
// URLs, so storage_url is a signed URL that lasts STORAGE_URL_TTL_SEC (10 years).
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";
import { upload, createSignedUrl } from "../_shared/storage.js";

export const router = express.Router();

const BUCKET = "course-thumbnails";
const STORAGE_URL_TTL_SEC = 10 * 365 * 24 * 60 * 60;
const DATA_URL_RE = /^data:image\/(\w+);base64,(.+)$/;

// Returns null when the request may continue, or the status and body to send back.
async function checkAdmin(req) {
  const h = req.get("Authorization");
  if (!h) return { status: 401, body: { error: "Missing authorization header" } };
  let claims;
  try {
    claims = jwt.verify(h.replace("Bearer ", ""), process.env.JWT_SECRET);
  } catch {
    return { status: 401, body: { error: "Invalid authentication" } };
  }
  if (!claims?.sub) return { status: 401, body: { error: "Invalid authentication" } };
  const { rows } = await query("SELECT role FROM public.user_roles WHERE user_id = $1", [claims.sub]);
  if (!rows.some((r) => r.role === "admin" || r.role === "super_admin")) {
    return { status: 403, body: { error: "Admin access required" } };
  }
  return null;
}

router.post("/", async (req, res) => {
  try {
    const denied = await checkAdmin(req);
    if (denied) return res.status(denied.status).json(denied.body);

    console.log("Starting thumbnail migration...");
    const { rows: courses } = await query(
      "SELECT id, name, thumbnail_url FROM public.courses WHERE thumbnail_url IS NOT NULL",
    );
    console.log(`Found ${courses.length} courses with thumbnails`);

    const results = [];
    let successCount = 0;
    let skipCount = 0;
    let failCount = 0;

    for (const course of courses) {
      try {
        const thumbnailUrl = course.thumbnail_url;

        if (!thumbnailUrl?.startsWith("data:image")) {
          console.log(`Skipping ${course.name}: not base64 data`);
          skipCount++;
          continue;
        }

        const { rows: existing } = await query(
          "SELECT id FROM public.course_thumbnails WHERE course_id = $1 LIMIT 1",
          [course.id],
        );
        if (existing[0]) {
          console.log(`Skipping ${course.name}: already migrated`);
          skipCount++;
          continue;
        }

        const base64Match = thumbnailUrl.match(DATA_URL_RE);
        if (!base64Match) {
          console.log(`Skipping ${course.name}: invalid base64 format`);
          skipCount++;
          continue;
        }

        const [, imageType, base64Data] = base64Match;
        const extension = imageType === "jpeg" ? "jpg" : imageType;
        const fileName = `${course.id}/thumbnail_${Date.now()}.${extension}`;
        const bytes = Buffer.from(base64Data, "base64");

        console.log(`Uploading thumbnail for ${course.name}...`);
        try {
          await upload(BUCKET, fileName, bytes);
        } catch (uploadError) {
          console.error(`Upload failed for ${course.name}:`, uploadError?.message);
          results.push({ courseId: course.id, courseName: course.name, success: false, error: uploadError.message });
          failCount++;
          continue;
        }

        const publicUrl = createSignedUrl(BUCKET, fileName, STORAGE_URL_TTL_SEC);
        try {
          await query(
            `INSERT INTO public.course_thumbnails (course_id, storage_url)
             VALUES ($1, $2)
             ON CONFLICT (course_id) DO UPDATE SET storage_url = EXCLUDED.storage_url, updated_at = now()`,
            [course.id, publicUrl],
          );
        } catch (dbError) {
          console.error(`Database insert failed for ${course.name}:`, dbError?.message);
          results.push({ courseId: course.id, courseName: course.name, success: false, error: dbError.message });
          failCount++;
          continue;
        }

        console.log(`Successfully migrated ${course.name}`);
        results.push({ courseId: course.id, courseName: course.name, success: true });
        successCount++;
      } catch (error) {
        console.error(`Error processing ${course.name}:`, error?.message);
        results.push({
          courseId: course.id,
          courseName: course.name,
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
        failCount++;
      }
    }

    res.json({
      total: courses.length,
      success: successCount,
      skipped: skipCount,
      failed: failCount,
      results,
    });
  } catch (error) {
    console.error("Migration error:", error?.message);
    res.status(500).json({ error: error instanceof Error ? error.message : "Migration failed" });
  }
});
