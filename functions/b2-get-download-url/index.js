// Port of supabase/functions/b2-get-download-url. Returns a 1-hour authorised download URL for a B2 file.
// POST { filePath } with a Bearer token.
import express from "express";
import { requireUserId, b2Authorize, encodePath } from "../_shared/b2-upload-helper.js";

export const router = express.Router();

router.post("/", async (req, res) => {
  try {
    requireUserId(req);
    const { filePath } = req.body || {};
    if (!filePath) throw new Error("File path is required");
    const bucketId = process.env.B2_BUCKET_ID;
    if (!process.env.B2_KEY_ID || !process.env.B2_APPLICATION_KEY || !bucketId) {
      throw new Error("B2 credentials not configured");
    }

    const auth = await b2Authorize();
    const encoded = encodePath(filePath);
    const authRes = await fetch(`${auth.apiUrl}/b2api/v2/b2_get_download_authorization`, {
      method: "POST",
      headers: { Authorization: auth.authorizationToken, "Content-Type": "application/json" },
      body: JSON.stringify({ bucketId, fileNamePrefix: encoded, validDurationInSeconds: 3600 }),
    });
    if (!authRes.ok) throw new Error(`Failed to get download authorization: ${await authRes.text()}`);
    const authData = await authRes.json();

    const downloadUrl = `${auth.downloadUrl}/file/${process.env.B2_BUCKET_NAME}/${encoded}?Authorization=${authData.authorizationToken}`;
    return res.json({ success: true, downloadUrl, expiresIn: 3600 });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : "Failed to generate download URL" });
  }
});
