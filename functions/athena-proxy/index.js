// Port of supabase/functions/athena-proxy. Generic proxy for the Athena AI API.
// The browser cannot call it directly from an HTTPS page (mixed content), so this forwards server-side.
// JSON and multipart/form-data bodies are both forwarded; multipart is sent as raw bytes.
//
//   GET  /functions/v1/athena-proxy?path=/subjects
//   POST /functions/v1/athena-proxy?path=/subjects&base=<allowed base URL>
//   POST /functions/v1/athena-proxy?path=/documents   (multipart/form-data body)
//
// The upstream is ATHENA_BASE_URL (default base). Extra origins may be listed in
// ATHENA_ALLOWED_BASES (comma-separated). Any base not on that list is refused.
import express from "express";

export const router = express.Router();

const ALLOWED_PATH = /^\/[a-zA-Z0-9_\-\/.]*$/;

const originsFromEnv = () => {
  const list = [process.env.ATHENA_BASE_URL, ...(process.env.ATHENA_ALLOWED_BASES || "").split(",")];
  const out = new Set();
  for (const s of list.map((x) => (x || "").trim()).filter(Boolean)) {
    try {
      out.add(new URL(s).origin);
    } catch {
      // ignore malformed entries
    }
  }
  return out;
};

const json = (res, status, body) => res.status(status).json(body);

// Keeps the raw body for multipart uploads (express.json has already parsed JSON bodies).
router.use(express.raw({ type: () => true, limit: "200mb" }));

router.all("/", async (req, res) => {
  try {
    const rawPath = typeof req.query.path === "string" ? req.query.path : "/";
    const baseParam = typeof req.query.base === "string" && req.query.base ? req.query.base : process.env.ATHENA_BASE_URL;
    if (!baseParam) return json(res, 500, { error: "ATHENA_BASE_URL not configured" });

    // A query string may be embedded in the path parameter.
    const qIdx = rawPath.indexOf("?");
    const pathOnly = qIdx >= 0 ? rawPath.slice(0, qIdx) : rawPath;
    const embeddedQuery = qIdx >= 0 ? rawPath.slice(qIdx + 1) : "";
    if (!ALLOWED_PATH.test(pathOnly)) return json(res, 400, { error: "Invalid path" });

    let upstreamBase;
    try {
      upstreamBase = new URL(baseParam);
      if (!/^https?:$/.test(upstreamBase.protocol)) throw new Error("bad proto");
    } catch {
      return json(res, 400, { error: "Invalid base URL" });
    }
    if (!originsFromEnv().has(upstreamBase.origin)) return json(res, 400, { error: "Base URL not allowed" });

    // Extra query params on the proxy URL (other than path and base) are forwarded.
    const extra = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query)) {
      if (k === "path" || k === "base") continue;
      if (Array.isArray(v)) v.forEach((x) => extra.append(k, String(x)));
      else extra.append(k, String(v));
    }
    const combinedQuery = [embeddedQuery, extra.toString()].filter(Boolean).join("&");
    const upstreamUrl = `${upstreamBase.origin}${pathOnly}${combinedQuery ? "?" + combinedQuery : ""}`;

    const method = req.method.toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD";
    const reqContentType = req.headers["content-type"] || "";
    const isMultipart = reqContentType.toLowerCase().includes("multipart/form-data");

    let body;
    if (hasBody) {
      if (Buffer.isBuffer(req.body)) body = req.body.length ? req.body : undefined;
      else if (req.body && Object.keys(req.body).length) body = JSON.stringify(req.body);
    }

    const maxAttempts = method === "GET" ? 2 : isMultipart ? 1 : 3;
    let lastErr = "Upstream fetch failed";
    let lastStatus;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const timeoutMs = isMultipart ? 600_000 : 420_000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const upstream = await fetch(upstreamUrl, {
          method,
          headers: { "Content-Type": reqContentType || "application/json" },
          body,
          signal: controller.signal,
        });
        clearTimeout(timer);
        const upstreamCT = upstream.headers.get("content-type") || "application/json";
        const isBinaryMedia = /^(audio|video|image)\//.test(upstreamCT) || upstreamCT.includes("application/octet-stream");
        if (upstreamCT.includes("text/event-stream") || isBinaryMedia) {
          res.status(upstream.status).set("Content-Type", upstreamCT);
          return res.send(Buffer.from(await upstream.arrayBuffer()));
        }
        const text = await upstream.text();
        if (upstream.ok) {
          return res.status(upstream.status).set("Content-Type", upstreamCT).send(text);
        }
        lastErr = text || `Upstream HTTP ${upstream.status}`;
        lastStatus = upstream.status;
        if (upstream.status >= 400 && upstream.status < 500) {
          return res.status(upstream.status).set("Content-Type", upstreamCT).send(text || JSON.stringify({ error: lastErr }));
        }
      } catch (err) {
        clearTimeout(timer);
        lastErr = err?.name === "AbortError" ? `Upstream timed out after ${timeoutMs / 1000}s` : err?.message || "Upstream fetch failed";
      }
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, attempt * 1000));
    }

    return json(res, 502, { error: lastErr, status: lastStatus, upstream: upstreamUrl });
  } catch (err) {
    return json(res, 500, { error: err?.message || "Unknown error" });
  }
});
