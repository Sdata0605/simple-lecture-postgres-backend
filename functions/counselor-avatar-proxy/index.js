// Port of supabase/functions/counselor-avatar-proxy. Forwards requests from the admin panel to the
// plain-HTTP Dynamic Avatar API (the browser cannot call http:// from an https page).
//
// Usage: GET|POST ... /functions/v1/counselor-avatar-proxy?path=/api/health&base=http://host:5004
//
// Upstream servers are not hard-coded. The default base is COUNSELOR_AVATAR_BASE_URL. Any other
// base must be listed in COUNSELOR_AVATAR_ALLOWED_BASES (comma-separated), so this cannot be used
// as an open proxy. Multipart bodies are forwarded as raw bytes.
import express from "express";

export const router = express.Router();
export const hooks = { fetch: null };

const ALLOWED_PATH = /^\/[a-zA-Z0-9_\-\/]*$/;
const rawBody = express.raw({ type: () => true, limit: "600mb" });

function allowedOrigins() {
  const entries = [process.env.COUNSELOR_AVATAR_BASE_URL, ...(process.env.COUNSELOR_AVATAR_ALLOWED_BASES || "").split(",")];
  const origins = new Set();
  for (const raw of entries.map((s) => (s || "").trim()).filter(Boolean)) {
    try {
      origins.add(new URL(raw).origin);
    } catch {
      // ignore malformed entries
    }
  }
  return origins;
}

const sendJson = (res, status, body) => res.status(status).type("application/json").send(JSON.stringify(body));

router.use(rawBody, async (req, res) => {
  try {
    const params = new URL(req.originalUrl, "http://proxy.local").searchParams;
    const rawPath = params.get("path") || "/";

    // A query string may be embedded inside the path parameter.
    const qIdx = rawPath.indexOf("?");
    const pathOnly = qIdx >= 0 ? rawPath.slice(0, qIdx) : rawPath;
    const embeddedQuery = qIdx >= 0 ? rawPath.slice(qIdx + 1) : "";

    if (!ALLOWED_PATH.test(pathOnly)) return sendJson(res, 400, { error: "Invalid path" });

    let upstreamBase;
    try {
      upstreamBase = new URL(params.get("base") || process.env.COUNSELOR_AVATAR_BASE_URL || "");
      if (!/^https?:$/.test(upstreamBase.protocol)) throw new Error("bad protocol");
    } catch {
      return sendJson(res, 400, { error: "Invalid base URL" });
    }
    if (!allowedOrigins().has(upstreamBase.origin)) return sendJson(res, 400, { error: "Base URL not allowed" });

    const extra = new URLSearchParams();
    for (const [k, v] of params.entries()) {
      if (k !== "path" && k !== "base") extra.append(k, v);
    }
    const combinedQuery = [embeddedQuery, extra.toString()].filter(Boolean).join("&");
    const upstreamUrl = `${upstreamBase.origin}${pathOnly}${combinedQuery ? "?" + combinedQuery : ""}`;

    const method = req.method.toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD";
    const reqContentType = req.headers["content-type"] || "";
    const isMultipart = reqContentType.toLowerCase().includes("multipart/form-data");

    let body;
    if (hasBody) {
      if (Buffer.isBuffer(req.body)) body = req.body;
      else if (typeof req.body === "string") body = req.body;
      else if (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0) body = JSON.stringify(req.body);
    }

    const isGet = method === "GET";
    const maxAttempts = isGet ? 3 : isMultipart ? 1 : 3;
    let lastErr = "Upstream fetch failed";
    let lastStatus;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeoutMs = isMultipart ? 300_000 : isGet ? 20_000 : 60_000;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const upstream = await (hooks.fetch ?? fetch)(upstreamUrl, {
          method,
          headers: { "Content-Type": reqContentType || "application/json" },
          body,
          signal: controller.signal,
        });
        clearTimeout(timer);
        const upstreamCT = upstream.headers.get("content-type") || "application/json";
        const text = await upstream.text();
        if (upstream.ok) {
          return res.status(upstream.status).type(upstreamCT).send(text);
        }
        lastErr = text || `Upstream HTTP ${upstream.status}`;
        lastStatus = upstream.status;
        if (upstream.status >= 400 && upstream.status < 500) {
          return res.status(upstream.status).type(upstreamCT).send(text || JSON.stringify({ error: lastErr }));
        }
      } catch (err) {
        clearTimeout(timer);
        lastErr = err?.name === "AbortError"
          ? `Upstream timed out after ${timeoutMs / 1000}s`
          : err?.message || "Upstream fetch failed";
      }
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, attempt * 1000));
    }

    return sendJson(res, 502, { error: lastErr, status: lastStatus, upstream: upstreamUrl });
  } catch (err) {
    return sendJson(res, 500, { error: err?.message || "Unknown error" });
  }
});
