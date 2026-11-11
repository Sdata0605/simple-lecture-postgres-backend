// Port of supabase/functions/b2-delete-file. Deletes a file version from B2 and its storage_files row.
// POST { fileName, fileId } with a Bearer token. Errors are returned as 500 { error }, as before.
import express from "express";
import { query } from "../_shared/db.js";
import { requireUserId, b2Authorize, b2ApiBase } from "../_shared/b2-upload-helper.js";

export const router = express.Router();

router.post("/", async (req, res) => {
  try {
    requireUserId(req);
    const { fileName, fileId } = req.body || {};
    if (!fileName || !fileId) throw new Error("fileName and fileId are required");
    if (!process.env.B2_KEY_ID || !process.env.B2_APPLICATION_KEY) throw new Error("B2 credentials not configured");

    const auth = await b2Authorize();
    const del = await fetch(`${auth.apiUrl || b2ApiBase()}/b2api/v2/b2_delete_file_version`, {
      method: "POST",
      headers: { Authorization: auth.authorizationToken, "Content-Type": "application/json" },
      body: JSON.stringify({ fileName, fileId }),
    });
    if (!del.ok) throw new Error(`B2 delete failed: ${await del.text()}`);

    try {
      await query("DELETE FROM public.storage_files WHERE b2_file_id = $1", [fileId]);
    } catch (e) {
      throw new Error(`Failed to delete file metadata: ${e.message}`);
    }
    return res.json({ success: true, message: "File deleted successfully" });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : "Delete failed" });
  }
});
