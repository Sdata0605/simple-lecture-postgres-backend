// Port of supabase/functions/kie-ai-common. Proxies two KIE.AI calls: check_credit and
// get_download_url. The key comes from KIE_AI_API_KEY and is never returned or logged.
// Auth: the original ran behind the Supabase JWT gate, so this requires a valid user Bearer token.
import express from "express";
import jwt from "jsonwebtoken";

export const router = express.Router();

const KIE_API_BASE = "https://api.kie.ai";
const TIMEOUT_MS = 30_000;

function hasValidBearer(req) {
  const h = req.get("Authorization") || "";
  if (!h.startsWith("Bearer ")) return false;
  try {
    return Boolean(jwt.verify(h.slice(7), process.env.JWT_SECRET)?.sub);
  } catch {
    return false;
  }
}

async function kie(path, init) {
  return fetch(KIE_API_BASE + path, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

router.post("/", async (req, res) => {
  try {
    if (!hasValidBearer(req)) return res.status(401).json({ error: "Unauthorized" });
    const KIE_AI_API_KEY = process.env.KIE_AI_API_KEY;
    if (!KIE_AI_API_KEY) throw new Error("KIE_AI_API_KEY is not configured");

    const { action, url } = req.body || {};
    const auth = `Bearer ${KIE_AI_API_KEY}`;

    if (action === "check_credit") {
      const response = await kie("/api/v1/chat/credit", { method: "GET", headers: { Authorization: auth } });
      const result = await response.json();
      if (!response.ok) {
        return res.status(response.status).json({ error: `KIE.AI API error: ${response.status}`, details: result });
      }
      return res.json({ credits: result.data });
    }

    if (action === "get_download_url") {
      if (!url) return res.status(400).json({ error: "URL is required" });
      const response = await kie("/api/v1/common/download-url", {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const result = await response.json();
      if (!response.ok) {
        return res.status(response.status).json({ error: `KIE.AI API error: ${response.status}`, details: result });
      }
      return res.json({ downloadUrl: result.data });
    }

    return res.status(400).json({ error: "Invalid action. Use check_credit or get_download_url" });
  } catch (error) {
    console.error("kie-ai-common error:", error?.message);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});
