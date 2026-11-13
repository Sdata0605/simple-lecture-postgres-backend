// Serves a resized, compressed copy of a course thumbnail. The originals are large PNGs (about 2.7 MB at 2400 px);
// the course cards only need a few hundred pixels, so this returns a WebP at the requested width and caches it on disk.
//
// GET /functions/v1/course-thumbnail?src=<thumbnail url>&w=<width>
// Only URLs under COURSE_THUMBNAIL_BASE (default: the course-thumbnails path of the production storage proxy) are
// fetched, so this route cannot be used to fetch arbitrary addresses.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import sharp from "sharp";
import { UPLOAD_ROOT } from "../_shared/storage.js";

export const router = express.Router();

const DEFAULT_BASE = "https://supabase-proxy.utuberpraveen.workers.dev/storage/v1/object/public/course-thumbnails/";
const MAX_SOURCE_BYTES = 15 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const CACHE_DIR = path.join(UPLOAD_ROOT, "thumb-cache");

const allowedBase = () => process.env.COURSE_THUMBNAIL_BASE || DEFAULT_BASE;

export function clampWidth(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 480;
  return Math.min(1200, Math.max(120, Math.round(n)));
}

// True only for an https URL that starts with the allowed base (no query tricks, no other hosts or paths).
export function isAllowedSource(src) {
  if (typeof src !== "string" || src.length > 500) return false;
  const base = allowedBase();
  if (!src.startsWith(base)) return false;
  return !src.includes("..");
}

router.get("/", async (req, res) => {
  const src = typeof req.query.src === "string" ? req.query.src : "";
  if (!isAllowedSource(src)) return res.status(400).json({ error: "invalid thumbnail source" });
  const width = clampWidth(req.query.w);

  const key = crypto.createHash("sha256").update(`${src}|${width}`).digest("hex");
  const cachePath = path.join(CACHE_DIR, `${key}.webp`);

  res.set("Cache-Control", "public, max-age=86400");
  res.set("Content-Type", "image/webp");

  try {
    if (fs.existsSync(cachePath)) return res.sendFile(cachePath);

    const upstream = await fetch(src, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!upstream.ok) return res.status(502).json({ error: "thumbnail not available" });
    const declared = Number(upstream.headers.get("content-length") || 0);
    if (declared > MAX_SOURCE_BYTES) return res.status(502).json({ error: "thumbnail too large" });
    const input = Buffer.from(await upstream.arrayBuffer());
    if (input.length > MAX_SOURCE_BYTES) return res.status(502).json({ error: "thumbnail too large" });

    const out = await sharp(input, { failOn: "none" })
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 78, effort: 4 })
      .toBuffer();

    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = `${cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, cachePath);
    return res.send(out);
  } catch (err) {
    console.error("[course-thumbnail] failed:", String(err?.name ?? err?.message ?? err).slice(0, 120));
    return res.status(502).json({ error: "thumbnail not available" });
  }
});

export default router;
