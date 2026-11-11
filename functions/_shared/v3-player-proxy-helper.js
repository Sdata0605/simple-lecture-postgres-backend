// Helpers shared by v3-player-proxy and v4-player-proxy: MIME types and the CDN fallback path.
const MIME_MAP = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
};

export function contentTypeFor(filePath) {
  const dot = filePath.lastIndexOf(".");
  const ext = dot === -1 ? "" : filePath.substring(dot).toLowerCase();
  return MIME_MAP[ext] || "application/octet-stream";
}

// /player/jobs/<job>/<file> -> <cdnOrigin>/<job>/<file>, or null for other paths.
export function cdnFallbackUrl(targetPath, search, cdnOrigin) {
  const match = targetPath.match(/^\/player\/jobs\/([^/]+)\/(.+)$/);
  if (!match) return null;
  const [, jobId, filePath] = match;
  return `${cdnOrigin}/${jobId}/${filePath}${search}`;
}
