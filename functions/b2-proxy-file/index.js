// Port of supabase/functions/b2-proxy-file. Streams a B2 file to the client.
// GET ?path=<file path>, with a Bearer token in the Authorization header or ?token= (for iframes).
import express from "express";
import jwt from "jsonwebtoken";
import { b2Authorize } from "../_shared/b2-upload-helper.js";

export const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const headerAuth = req.headers.authorization;
    const queryToken = typeof req.query.token === "string" ? req.query.token : "";
    const token = headerAuth ? String(headerAuth).replace(/^Bearer\s+/i, "").trim() : queryToken;
    if (!token) return res.status(401).json({ error: "No authorization provided" });
    try {
      if (!jwt.verify(token, process.env.JWT_SECRET)?.sub) throw new Error("no sub");
    } catch {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const filePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!filePath) return res.status(400).json({ error: "Missing file path" });

    const bucketName = process.env.B2_BUCKET_NAME;
    if (!process.env.B2_KEY_ID || !process.env.B2_APPLICATION_KEY || !bucketName) {
      return res.status(500).json({ error: "Server configuration error" });
    }

    let auth;
    try {
      auth = await b2Authorize();
    } catch {
      return res.status(500).json({ error: "Storage authorization failed" });
    }

    const fileRes = await fetch(`${auth.downloadUrl}/file/${bucketName}/${filePath}`, {
      headers: { Authorization: auth.authorizationToken },
    });
    if (!fileRes.ok) {
      await fileRes.text().catch(() => "");
      return res.status(404).json({ error: "File not found" });
    }

    let contentType = fileRes.headers.get("content-type") || "application/octet-stream";
    if (filePath.toLowerCase().endsWith(".pdf")) contentType = "application/pdf";

    res.status(200);
    res.set({
      "Content-Type": contentType,
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=3600",
    });
    return res.send(Buffer.from(await fileRes.arrayBuffer()));
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : "Unknown error" });
  }
});
