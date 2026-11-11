// Port of supabase/functions/ai-teaching-proxy. Generic proxy for the plain-HTTP AI Teaching API.
// The browser cannot call it directly from an HTTPS page (mixed content), so this forwards server-side.
//
//   POST /functions/v1/ai-teaching-proxy?path=/questions/import&base=<allowed base URL>
//   GET  /functions/v1/ai-teaching-proxy?path=/pregen/status
//
// The default upstream is AI_TEACHING_BASE_URL. Extra origins may be listed in AI_TEACHING_ALLOWED_BASES.
import express from "express";

export const router = express.Router();

const ALLOWED_PATH = /^\/[a-zA-Z0-9_\-\/]*$/;

const originsFromEnv = () => {
  const list = [process.env.AI_TEACHING_BASE_URL, ...(process.env.AI_TEACHING_ALLOWED_BASES || "").split(",")];
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

// Raw body, so the request is forwarded exactly as sent.
router.use(express.raw({ type: () => true, limit: "50mb" }));

router.all("/", async (req, res) => {
  try {
    const rawPath = typeof req.query.path === "string" ? req.query.path : "/";
    const baseParam = typeof req.query.base === "string" && req.query.base ? req.query.base : process.env.AI_TEACHING_BASE_URL;
    if (!baseParam) return json(res, 500, { error: "AI_TEACHING_BASE_URL not configured" });

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
    // express.json (app level) parses JSON bodies into objects; anything else arrives as a Buffer.
    let body;
    if (hasBody) {
      if (Buffer.isBuffer(req.body)) body = req.body.length ? req.body.toString("utf8") : undefined;
      else if (req.body && typeof req.body === "object" && Object.keys(req.body).length) body = JSON.stringify(req.body);
    }

    const maxAttempts = method === "GET" ? 2 : 3;
    let lastErr = "Upstream fetch failed";
    let lastStatus;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const upstream = await fetch(upstreamUrl, {
          method,
          headers: { "Content-Type": req.headers["content-type"] || "application/json" },
          body,
          signal: AbortSignal.timeout(420_000),
        });
        const text = await upstream.text();
        const ct = upstream.headers.get("content-type") || "application/json";
        if (upstream.ok) return res.status(upstream.status).set("Content-Type", ct).send(text);

        lastErr = text || `Upstream HTTP ${upstream.status}`;
        lastStatus = upstream.status;
        if (upstream.status >= 400 && upstream.status < 500) {
          return res.status(upstream.status).set("Content-Type", ct).send(text || JSON.stringify({ error: lastErr }));
        }
      } catch (err) {
        lastErr = err?.name === "TimeoutError" || err?.name === "AbortError"
          ? "Upstream timed out after 420s"
          : err?.message || "Upstream fetch failed";
      }
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, attempt * 1000));
    }

    return json(res, 502, { error: lastErr, status: lastStatus, upstream: upstreamUrl });
  } catch (err) {
    return json(res, 500, { error: err?.message || "Unknown error" });
  }
});
