// Port of supabase/functions/v3-player-proxy. Serves the v3 video player's files (HTML/JS/CSS/media) from
// the player origin, falling back to the CDN for /player/jobs/<job>/<file> when the origin fails.
// Mounted at /functions/v1/v3-player-proxy; the path after the mount is the file path. Public (media
// elements cannot send headers), as the original. Range requests are forwarded.
// Env: V3_PLAYER_ORIGIN (e.g. http://host:port, required), V3_PLAYER_CDN_ORIGIN (default the public CDN).
import express from "express";
import { Readable } from "node:stream";
import { contentTypeFor, cdnFallbackUrl } from "../_shared/v3-player-proxy-helper.js";

export const router = express.Router();

const DEFAULT_CDN_ORIGIN = "https://server1.simplelecture.com/video";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, range",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

router.use(async (req, res) => {
  res.set(corsHeaders);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const origin = (process.env.V3_PLAYER_ORIGIN || "").replace(/\/$/, "");
    if (!origin) return res.status(503).json({ error: "Player origin not configured" });
    const cdnOrigin = (process.env.V3_PLAYER_CDN_ORIGIN || DEFAULT_CDN_ORIGIN).replace(/\/$/, "");

    let targetPath = req.path || "/";
    if (!targetPath.startsWith("/")) targetPath = "/" + targetPath;
    const qIndex = req.originalUrl.indexOf("?");
    const search = qIndex === -1 ? "" : req.originalUrl.substring(qIndex);

    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;

    let upstream = await fetch(`${origin}${targetPath}${search}`, { headers });
    if (!upstream.ok) {
      const fallback = cdnFallbackUrl(targetPath, search, cdnOrigin);
      if (fallback) {
        upstream.body?.cancel().catch(() => {});
        upstream = await fetch(fallback, { headers });
      }
    }

    res.status(upstream.status);
    res.set({ ...corsHeaders, "Content-Type": contentTypeFor(targetPath), "Cache-Control": "public, max-age=3600" });
    for (const name of ["content-length", "content-range", "accept-ranges"]) {
      const value = upstream.headers.get(name);
      if (value) res.set(name, value);
    }

    if (!upstream.body || req.method === "HEAD") return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
    return undefined;
  } catch (error) {
    console.error("v3-player-proxy error:", error?.message);
    if (!res.headersSent) return res.status(502).json({ error: "Proxy error" });
    return res.end();
  }
});

export default router;
