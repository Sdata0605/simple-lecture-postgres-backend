// Port of supabase/functions/migrate-category-icons. Admin-only one-off migration: moves base64
// category icons (data:image/...) into the category-icons bucket and points categories.icon at the
// stored file. Auth: Bearer token of a user with role admin or super_admin.
// Note: the original stored permanent public URLs. This server serves files only through signed
// URLs, so the new icon URL is a signed URL that lasts ICON_URL_TTL_SEC (10 years).
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";
import { upload, createSignedUrl } from "../_shared/storage.js";

export const router = express.Router();

const BUCKET = "category-icons";
const ICON_URL_TTL_SEC = 10 * 365 * 24 * 60 * 60;
const DATA_URL_RE = /^data:image\/(\w+);base64,(.+)$/;

// Returns null when the request may continue, or the status and body to send back.
async function checkAdmin(req) {
  const h = req.get("Authorization");
  if (!h) return { status: 401, body: { error: "Authorization required" } };
  let claims;
  try {
    claims = jwt.verify(h.replace("Bearer ", ""), process.env.JWT_SECRET);
  } catch {
    return { status: 401, body: { error: "Invalid token" } };
  }
  if (!claims?.sub) return { status: 401, body: { error: "Invalid token" } };
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

    console.log("Starting category icon migration...");
    const { rows: categories } = await query(
      "SELECT id, name, icon FROM public.categories WHERE icon IS NOT NULL",
    );

    let migrated = 0;
    let skipped = 0;
    let errors = 0;
    const results = [];

    for (const category of categories) {
      if (!category.icon?.startsWith("data:image")) {
        skipped++;
        results.push({ id: category.id, name: category.name, status: "skipped" });
        continue;
      }

      try {
        const matches = category.icon.match(DATA_URL_RE);
        if (!matches) {
          console.log(`Invalid base64 format for category ${category.id}`);
          errors++;
          results.push({ id: category.id, name: category.name, status: "invalid_format" });
          continue;
        }

        const [, ext, base64Data] = matches;
        const fileExt = ext === "jpeg" ? "jpg" : ext;
        const fileName = `${category.id}/icon_${Date.now()}.${fileExt}`;
        const bytes = Buffer.from(base64Data, "base64");

        try {
          await upload(BUCKET, fileName, bytes);
        } catch (uploadError) {
          console.error(`Upload failed for category ${category.id}:`, uploadError?.message);
          errors++;
          results.push({ id: category.id, name: category.name, status: "upload_failed" });
          continue;
        }

        const url = createSignedUrl(BUCKET, fileName, ICON_URL_TTL_SEC);
        await query("UPDATE public.categories SET icon = $2 WHERE id = $1", [category.id, url]);

        migrated++;
        results.push({ id: category.id, name: category.name, status: "migrated", url });
        console.log(`Migrated category ${category.name}`);
      } catch (err) {
        console.error(`Error processing category ${category.id}:`, err?.message);
        errors++;
        results.push({ id: category.id, name: category.name, status: "error" });
      }
    }

    console.log(`Migration complete: ${migrated} migrated, ${skipped} skipped, ${errors} errors`);

    res.json({
      success: true,
      summary: { migrated, skipped, errors, total: categories.length },
      results,
    });
  } catch (error) {
    console.error("Migration error:", error?.message);
    res.status(500).json({ error: error instanceof Error ? error.message : "Migration failed" });
  }
});
