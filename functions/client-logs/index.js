// POST /api/client-logs: frontend errors go to public.system_logs (category "frontend").
// Public endpoint, so it is rate limited per IP, body size limited, and every field is capped.
import express from "express";
import { logFromReq } from "../_shared/system-log.js";

export const router = express.Router();

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 30;
const hits = new Map(); // ip -> { count, windowStart }

function allow(ip, now = Date.now()) {
  // Drop expired windows so the map cannot grow without limit under many client IPs.
  if (hits.size > 10000) {
    for (const [k, v] of hits) if (now - v.windowStart >= WINDOW_MS) hits.delete(k);
  }
  const cur = hits.get(ip);
  if (!cur || now - cur.windowStart >= WINDOW_MS) {
    hits.set(ip, { count: 1, windowStart: now });
    return true;
  }
  cur.count += 1;
  return cur.count <= MAX_PER_WINDOW;
}

const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : undefined);

router.post("/", express.json({ limit: "16kb" }), (req, res) => {
  if (!allow(req.ip || "unknown")) return res.status(429).json({ error: "rate_limited" });
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const message = str(b.message, 300);
  if (!message) return res.status(400).json({ error: "message_required" });
  logFromReq(req, {
    category: "frontend",
    event: str(b.event, 80) || "error",
    outcome: "failed",
    statusCode: null,
    message,
    durationMs: null,
    details: {
      page: str(b.page, 200),
      stack: str(b.stack, 2000),
      source: str(b.source, 200),
      app_version: str(b.app_version, 40),
    },
  });
  return res.status(202).json({ ok: true });
});

export function _resetClientLogRateLimit() {
  hits.clear();
}
