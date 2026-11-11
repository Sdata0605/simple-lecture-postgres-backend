// Port of supabase/functions/v4-player-proxy. Like v3-player-proxy, plus per-request origin overrides and
// bounded media ranges.
//   Origin: V4_PLAYER_ORIGIN_IP / V4_PLAYER_ORIGIN_PORT (default port 5006). Required when no override is given.
//   Overrides: ?__ip=&__port= select another origin, but only if "ip:port" is in V4_PLAYER_ALLOWED_ORIGINS
//              (comma-separated). Anything else returns 400.
//   Ranges: ?__range= or a Range header; for media, an open "bytes=N-" request is capped at 1 MiB.
// Falls back to the CDN for /player/jobs/<job>/<file> when the origin fails (V4_PLAYER_CDN_ORIGIN).
import express from "express";
import { Readable } from "node:stream";
import { contentTypeFor, cdnFallbackUrl } from "../_shared/v3-player-proxy-helper.js";

export const router = express.Router();

const DEFAULT_CDN_ORIGIN = "https://server1.simplelecture.com/video";
const STREAM_CHUNK_BYTES = 1024 * 1024;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, range",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Expose-Headers": "content-length, content-range, accept-ranges",
};

function isStreamableMedia(filePath) {
  return /\.(mp4|webm|mp3|wav|ogg)$/i.test(filePath);
}

export function boundRange(rangeHeader, filePath) {
  if (!rangeHeader || !isStreamableMedia(filePath)) return rangeHeader;
  const match = rangeHeader.match(/^bytes=(\d+)-$/i);
  if (!match) return rangeHeader;
  const start = Number(match[1]);
  if (!Number.isFinite(start) || start < 0) return rangeHeader;
  return `bytes=${start}-${start + STREAM_CHUNK_BYTES - 1}`;
}

function allowedOrigins() {
  return new Set(
    (process.env.V4_PLAYER_ALLOWED_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

router.use(async (req, res) => {
  res.set(corsHeaders);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    let targetPath = req.path || "/";
    if (!targetPath.startsWith("/")) targetPath = "/" + targetPath;

    const search = new URLSearchParams(req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?") + 1) : "");
    const rangeFromQuery = search.get("__range");
    const overrideIp = search.get("__ip");
    const overridePort = search.get("__port");
    search.delete("__range");
    search.delete("__ip");
    search.delete("__port");

    const defaultIp = process.env.V4_PLAYER_ORIGIN_IP || "";
    const defaultPort = process.env.V4_PLAYER_ORIGIN_PORT || "5006";
    const originIp = overrideIp || defaultIp;
    const originPort = overridePort || defaultPort;
    if (overrideIp || overridePort) {
      if (!allowedOrigins().has(`${originIp}:${originPort}`)) {
        return res.status(400).json({ error: "Origin not allowed" });
      }
    }
    if (!originIp) return res.status(503).json({ error: "Player origin not configured" });

    const cdnOrigin = (process.env.V4_PLAYER_CDN_ORIGIN || DEFAULT_CDN_ORIGIN).replace(/\/$/, "");
    const origin = `http://${originIp}:${originPort}`;
    const upstreamQuery = search.toString();
    const suffix = upstreamQuery ? `?${upstreamQuery}` : "";

    const requestedRange = req.headers.range || rangeFromQuery || null;
    const rangeHeader = boundRange(requestedRange, targetPath);
    const headers = {};
    if (rangeHeader) headers.Range = rangeHeader;

    let upstream = await fetch(`${origin}${targetPath}${suffix}`, { headers });
    if (!upstream.ok) {
      const fallback = cdnFallbackUrl(targetPath, suffix, cdnOrigin);
      if (fallback) {
        upstream.body?.cancel().catch(() => {});
        upstream = await fetch(fallback, { headers });
      }
    }

    res.status(upstream.status);
    res.set({
      ...corsHeaders,
      "Content-Type": contentTypeFor(targetPath),
      "Cache-Control": "public, max-age=3600",
      "X-V4-Requested-Range": requestedRange || "",
      "X-V4-Upstream-Range": rangeHeader || "",
    });
    for (const name of ["content-length", "content-range", "accept-ranges"]) {
      const value = upstream.headers.get(name);
      if (value) res.set(name, value);
    }

    if (!upstream.body || req.method === "HEAD") return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
    return undefined;
  } catch (error) {
    console.error("v4-player-proxy error:", error?.message);
    if (!res.headersSent) return res.status(502).json({ error: "Proxy error" });
    return res.end();
  }
});

export default router;
