// Port of supabase/functions/gap-patcher-proxy. Admin-only proxy to the gap patcher service.
// The upstream base URL comes from GAP_PATCHER_BASE_URL (never hard-coded).
// Auth: Bearer user token, then public.user_roles must contain role 'admin' for that user.
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";

export const router = express.Router();

const UPSTREAM_TIMEOUT_MS = 60_000;

function bearer(req) {
  const h = req.get("Authorization");
  if (!h?.startsWith("Bearer ")) return null;
  return h.slice(7);
}

router.use(async (req, res) => {
  try {
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    let claims;
    try {
      claims = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!claims?.sub) return res.status(401).json({ error: "Unauthorized" });

    const { rows } = await query(
      "SELECT 1 FROM public.user_roles WHERE user_id = $1 AND role = 'admin' LIMIT 1",
      [claims.sub],
    );
    if (!rows[0]) return res.status(403).json({ error: "Forbidden" });

    const base = (process.env.GAP_PATCHER_BASE_URL || "").replace(/\/$/, "");
    if (!base) return res.status(500).json({ error: "GAP_PATCHER_BASE_URL is not configured" });

    // req.path is already relative to the mount point. Empty or "/" means the health check.
    let forwardPath = req.path || "/";
    if (!forwardPath.startsWith("/")) forwardPath = "/" + forwardPath;
    if (forwardPath === "/") forwardPath = "/api/health";
    const search = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const target = base + forwardPath + search;

    const init = { method: req.method, headers: { "Content-Type": "application/json" } };
    if (["POST", "PUT", "PATCH"].includes(req.method)) {
      init.body = req.body !== undefined && Object.keys(req.body || {}).length ? JSON.stringify(req.body) : "";
    }
    init.signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);

    const upstream = await fetch(target, init);
    const text = await upstream.text();
    res.status(upstream.status).type("application/json").send(text || "{}");
  } catch (e) {
    console.error("gap-patcher-proxy error", e?.message);
    res.status(500).json({ error: String(e?.message || e) });
  }
});
