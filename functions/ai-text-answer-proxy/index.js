// Port of supabase/functions/ai-text-answer-proxy. Proxies the doubts tab to the external AI text-answer
// service. The API key stays on the server (AI_TEXT_ANSWER_API_KEY) and the upstream URL comes from
// AI_TEXT_ANSWER_URL.
// POST { question, subjectId, subjectName?, language? }.
import express from "express";

export const router = express.Router();

const DEFAULT_UPSTREAM = "http://116.202.230.124:8000/ai-text-answer";

router.all("/", async (req, res) => {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const question = typeof body.question === "string" ? body.question.trim() : "";
    const subjectId = typeof body.subjectId === "string" ? body.subjectId : "";
    const subjectName = typeof body.subjectName === "string" ? body.subjectName : undefined;
    const language = typeof body.language === "string" ? body.language : "en";

    if (!question || !subjectId) return res.status(400).json({ error: "question and subjectId are required" });

    // Same upstream as the Supabase version; AI_TEXT_ANSWER_URL overrides it. The key is optional: it is sent
    // only when AI_TEXT_ANSWER_API_KEY is set (the upstream answers without one).
    const apiKey = process.env.AI_TEXT_ANSWER_API_KEY || "";
    const upstreamUrl = process.env.AI_TEXT_ANSWER_URL || DEFAULT_UPSTREAM;

    let upstream;
    try {
      upstream = await fetch(upstreamUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey ? { "X-API-Key": apiKey } : {}) },
        body: JSON.stringify({ question, subjectId, subjectName, language }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      console.error("[ai-text-answer-proxy] upstream fetch failed", err?.name);
      return res.status(502).json({ error: err?.name === "TimeoutError" || err?.name === "AbortError" ? "Upstream timeout" : "Upstream unreachable" });
    }

    const text = await upstream.text();
    return res
      .status(upstream.status)
      .set("Content-Type", upstream.headers.get("Content-Type") || "application/json")
      .send(text);
  } catch (err) {
    console.error("[ai-text-answer-proxy] unexpected", err?.message);
    return res.status(500).json({ error: err?.message || "Unexpected error" });
  }
});
