// Port of supabase/functions/b2-upload. Moves a temp upload to Backblaze B2 and records storage_files.
// POST { storagePath, filePath, fileName, fileType, fileSize, metadata } with a Bearer token.
// The temp file is read from the local storage bucket "temp-uploads" (see _shared/storage.js).
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import { query } from "../_shared/db.js";
import { readFile } from "../_shared/storage.js";
import { requireUserId, b2Authorize, encodePath, sha1Hex } from "../_shared/b2-upload-helper.js";

export const router = express.Router();

const TEMP_BUCKET = "temp-uploads";
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(process.cwd(), "storage-data"));

// Retries only on the transient 503 errors B2 returns, with exponential backoff.
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
  let lastError = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const msg = error instanceof Error ? error.message : String(error);
      const transient = msg.includes("503") || msg.includes("service_unavailable") || msg.includes("no tomes available");
      if (!transient) throw error;
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, baseDelay * Math.pow(2, attempt)));
      }
    }
  }
  throw lastError || new Error("All retry attempts failed");
}

// Removes a temp file. Non-fatal in the caller, as in the original.
async function removeTemp(storagePath) {
  const parts = String(storagePath).split("/");
  if (parts.some((s) => s === "..") || storagePath.includes("\0")) throw new Error("invalid storage path");
  const full = path.resolve(UPLOAD_DIR, TEMP_BUCKET, ...parts);
  if (!full.startsWith(path.join(UPLOAD_DIR, TEMP_BUCKET) + path.sep)) throw new Error("invalid storage path");
  await fs.unlink(full);
}

router.post("/", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const { storagePath, filePath, fileName, fileType, fileSize, metadata = {} } = req.body || {};

    let fileBytes;
    try {
      fileBytes = new Uint8Array(await readFile(TEMP_BUCKET, storagePath));
    } catch (e) {
      throw new Error(`Failed to download temp file: ${e.message}`);
    }

    if (!process.env.B2_KEY_ID || !process.env.B2_APPLICATION_KEY || !process.env.B2_BUCKET_ID) {
      throw new Error("B2 credentials not configured");
    }
    const bucketId = process.env.B2_BUCKET_ID;
    const auth = await b2Authorize();

    const uploadUrlData = await retryWithBackoff(async () => {
      const r = await fetch(`${auth.apiUrl}/b2api/v2/b2_get_upload_url`, {
        method: "POST",
        headers: { Authorization: auth.authorizationToken, "Content-Type": "application/json" },
        body: JSON.stringify({ bucketId }),
      });
      if (!r.ok) throw new Error(`Failed to get upload URL (${r.status}): ${await r.text()}`);
      return r.json();
    });

    const sha1 = sha1Hex(fileBytes);
    const encodedFilePath = encodePath(filePath);

    const uploadResult = await retryWithBackoff(async () => {
      const r = await fetch(uploadUrlData.uploadUrl, {
        method: "POST",
        headers: {
          Authorization: uploadUrlData.authorizationToken,
          "X-Bz-File-Name": encodedFilePath,
          "Content-Type": fileType,
          "X-Bz-Content-Sha1": sha1,
        },
        body: fileBytes,
      });
      if (!r.ok) throw new Error(`Upload failed (${r.status}): ${await r.text()}`);
      return r.json();
    });

    // Temp cleanup is non-fatal, as in the original.
    await removeTemp(storagePath).catch(() => {});

    let storageFile;
    try {
      const { rows } = await query(
        `INSERT INTO public.storage_files
           (file_name, file_path, file_size, file_type, b2_file_id, entity_type,
            category_id, subject_id, chapter_id, topic_id, subtopic_id, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          fileName,
          encodedFilePath,
          fileBytes.length,
          fileType,
          uploadResult.fileId,
          metadata.entityType,
          metadata.categoryId || null,
          metadata.subjectId || null,
          metadata.chapterId || null,
          metadata.topicId || null,
          metadata.subtopicId || null,
          userId,
        ]
      );
      storageFile = rows[0];
    } catch (e) {
      throw new Error(`Failed to save file metadata: ${e.message}`);
    }

    return res.json({ success: true, fileId: uploadResult.fileId, filePath: encodedFilePath, storageFile });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : "Upload failed" });
  }
});
