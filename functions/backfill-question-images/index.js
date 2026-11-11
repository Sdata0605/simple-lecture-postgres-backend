// Port of supabase/functions/backfill-question-images. Indexes files in the local "pdf-images" bucket
// into public.question_images, one folder batch at a time.
// POST { offset?, limit? } (defaults 0 and 10). The original had no check of its own (it was only
// reachable with the service role), so this port requires the x-service-key header (SERVICE_KEY).
import express from "express";
import { query } from "../_shared/db.js";
import { list } from "../_shared/storage.js";

export const router = express.Router();

const BUCKET = "pdf-images";

router.post("/", async (req, res) => {
  try {
    const expected = process.env.SERVICE_KEY;
    if (!expected || req.headers["x-service-key"] !== expected) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const offset = Number.isFinite(Number(req.body?.offset)) ? Number(req.body.offset) : 0;
    const limit = Number.isFinite(Number(req.body?.limit)) ? Number(req.body.limit) : 10;
    const publicBase = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

    // Each top-level entry of the bucket is treated as a folder. Entries that are not folders
    // list as empty and produce no rows.
    const folderItems = await list(BUCKET, "", { limit: 500 });
    const batch = folderItems.slice(offset, offset + limit);

    const rows = [];
    for (const folder of batch) {
      const files = await list(BUCKET, folder.name, { limit: 1000 });
      for (const file of files) {
        const storagePath = `${folder.name}/${file.name}`;
        rows.push({
          original_filename: file.name,
          storage_path: storagePath,
          public_url: `${publicBase}/storage/v1/object/public/${BUCKET}/${storagePath}`,
          datalab_request_id: folder.name,
        });
      }
    }

    let totalInserted = 0;
    for (const r of rows) {
      const result = await query(
        `INSERT INTO public.question_images (original_filename, storage_path, public_url, datalab_request_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (storage_path) DO NOTHING`,
        [r.original_filename, r.storage_path, r.public_url, r.datalab_request_id]
      );
      totalInserted += result.rowCount || 0;
    }

    return res.json({
      success: true,
      totalFolders: folderItems.length,
      processedFolders: batch.length,
      offset,
      nextOffset: offset + limit < folderItems.length ? offset + limit : null,
      filesFound: rows.length,
      inserted: totalInserted,
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : "Unknown error" });
  }
});
