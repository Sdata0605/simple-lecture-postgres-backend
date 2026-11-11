// Port of supabase/functions/b2-large-upload. Multipart upload to B2 for files over 100 MB.
// POST { action: 'start' | 'upload-part' | 'finish' | 'cancel', ...params } with a Bearer token.
import express from "express";
import { requireUserId, b2Authorize, encodePath, sha1Hex } from "../_shared/b2-upload-helper.js";

export const router = express.Router();

const fail = (res, e, fallback) => res.status(500).json({ error: e instanceof Error ? e.message : fallback });

router.post("/", async (req, res) => {
  try {
    requireUserId(req);
    const { action, ...params } = req.body || {};

    if (!process.env.B2_KEY_ID || !process.env.B2_APPLICATION_KEY || !process.env.B2_BUCKET_ID) {
      throw new Error("B2 credentials not configured");
    }
    const bucketId = process.env.B2_BUCKET_ID;
    const auth = await b2Authorize();
    const b2Post = (apiPath, body, token = auth.authorizationToken) =>
      fetch(`${auth.apiUrl}/b2api/v2/${apiPath}`, {
        method: "POST",
        headers: { Authorization: token, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    switch (action) {
      case "start": {
        const { fileName, contentType } = params;
        const r = await b2Post("b2_start_large_file", {
          bucketId,
          fileName: encodePath(fileName),
          contentType: contentType || "video/mp4",
        });
        if (!r.ok) throw new Error(`Failed to start large file: ${await r.text()}`);
        const data = await r.json();
        return res.json({ success: true, fileId: data.fileId });
      }

      case "upload-part": {
        const { fileId, partNumber, partData } = params;
        const urlRes = await b2Post("b2_get_upload_part_url", { fileId });
        if (!urlRes.ok) throw new Error(`Failed to get upload URL: ${await urlRes.text()}`);
        const urlData = await urlRes.json();

        const partBytes = Buffer.from(String(partData), "base64");
        const partSha1 = sha1Hex(partBytes);
        const up = await fetch(urlData.uploadUrl, {
          method: "POST",
          headers: {
            Authorization: urlData.authorizationToken,
            "X-Bz-Part-Number": String(partNumber),
            "X-Bz-Content-Sha1": partSha1,
          },
          body: partBytes,
        });
        if (!up.ok) throw new Error(`Failed to upload part: ${await up.text()}`);
        return res.json({ success: true, partSha1 });
      }

      case "finish": {
        const { fileId, partSha1Array } = params;
        const r = await b2Post("b2_finish_large_file", { fileId, partSha1Array });
        if (!r.ok) throw new Error(`Failed to finish large file: ${await r.text()}`);
        return res.json({ success: true, file: await r.json() });
      }

      case "cancel": {
        const { fileId } = params;
        const r = await b2Post("b2_cancel_large_file", { fileId });
        if (!r.ok) console.warn("Failed to cancel large file:", await r.text());
        return res.json({ success: true });
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  } catch (e) {
    return fail(res, e, "Operation failed");
  }
});
