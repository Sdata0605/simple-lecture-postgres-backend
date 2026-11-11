// Port of supabase/functions/b2-list-files. Lists B2 files under a prefix and joins storage_files metadata.
// POST { prefix?, delimiter? }. The original had no auth check of its own (the Supabase gateway
// required a valid JWT), so this port requires a Bearer token signed with JWT_SECRET.
import express from "express";
import { query } from "../_shared/db.js";
import { requireUserId, b2Authorize, encodePath } from "../_shared/b2-upload-helper.js";

export const router = express.Router();

router.post("/", async (req, res) => {
  try {
    requireUserId(req);
    const { prefix = "", delimiter = "/" } = req.body || {};
    const bucketId = process.env.B2_BUCKET_ID;
    if (!process.env.B2_KEY_ID || !process.env.B2_APPLICATION_KEY || !bucketId) {
      throw new Error("B2 credentials not configured");
    }

    const auth = await b2Authorize();
    const listRes = await fetch(`${auth.apiUrl}/b2api/v2/b2_list_file_names`, {
      method: "POST",
      headers: { Authorization: auth.authorizationToken, "Content-Type": "application/json" },
      body: JSON.stringify({ bucketId, prefix, delimiter, maxFileCount: 1000 }),
    });
    if (!listRes.ok) throw new Error(`Failed to list files: ${await listRes.text()}`);
    const listData = await listRes.json();

    const names = listData.files.map((f) => f.fileName);
    let metaRows = [];
    if (names.length > 0) {
      ({ rows: metaRows } = await query("SELECT * FROM public.storage_files WHERE file_path = ANY($1::text[])", [names]));
    }

    const files = listData.files.map((file) => {
      const meta = metaRows.find((m) => m.file_path === file.fileName);
      return {
        ...file,
        downloadUrl: `${auth.downloadUrl}/file/${process.env.B2_BUCKET_NAME}/${encodePath(file.fileName)}`,
        metadata: meta || null,
      };
    });
    const folders = (listData.folders || []).map((name) => ({ name, isFolder: true }));
    return res.json({ files, folders, nextFileName: listData.nextFileName || null });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : "List files failed" });
  }
});
