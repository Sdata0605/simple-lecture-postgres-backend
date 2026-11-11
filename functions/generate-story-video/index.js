// Port of supabase/functions/generate-story-video. Asks KIE.AI (WAN 2.2) for a short educational
// video. Tries the primary endpoint, then the alternative one, then polls a returned task for up
// to about 60 seconds. The key comes from KIE_AI_API_KEY and is never logged or returned.
// Auth: Bearer user token (the original relied on the platform JWT gate).
import express from "express";
import jwt from "jsonwebtoken";

export const router = express.Router();

// Test hook: lets tests stub KIE.AI so no real request is sent.
export const hooks = { fetch: (...args) => fetch(...args), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

const KIE = "https://api.kie.ai";
const POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 2000;

function hasValidBearer(req) {
  const h = req.get("Authorization") || "";
  if (!h.startsWith("Bearer ")) return false;
  try {
    return Boolean(jwt.verify(h.slice(7), process.env.JWT_SECRET)?.sub);
  } catch {
    return false;
  }
}

router.post("/", async (req, res) => {
  try {
    if (!hasValidBearer(req)) return res.status(401).json({ error: "Unauthorized" });
    const { storyText, prompt } = req.body || {};

    if (!storyText && !prompt) {
      return res.status(400).json({ error: "Story text or prompt is required" });
    }

    const KIE_AI_API_KEY = process.env.KIE_AI_API_KEY;
    if (!KIE_AI_API_KEY) {
      console.log("KIE_AI_API_KEY not configured, returning placeholder");
      return res.json({
        success: false,
        error: "Video generation not configured - KIE_AI_API_KEY missing",
        videoUrl: null,
      });
    }

    const auth = `Bearer ${KIE_AI_API_KEY}`;
    const videoPrompt =
      prompt || `Educational animation showing: ${String(storyText).substring(0, 150)}. Simple, clear visuals with smooth motion.`;

    console.log("Generating video with WAN 2.2 via kie.ai:", videoPrompt.substring(0, 80));

    const response = await hooks.fetch(`${KIE}/api/v1/video/wan/generate`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: videoPrompt,
        model: "wan-2.2",
        resolution: "480p",
        aspect_ratio: "16:9",
        duration: 5,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    console.log("KIE.AI Response status:", response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("KIE.AI API error:", response.status);

      console.log("Trying alternative endpoint...");
      const altResponse = await hooks.fetch(`${KIE}/v1/generations`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "wan-2.2",
          prompt: videoPrompt,
          type: "video",
          settings: { resolution: "480p", aspect_ratio: "16:9", duration: 5 },
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!altResponse.ok) {
        console.error("KIE.AI alt endpoint error:", altResponse.status);
        return res.json({
          success: false,
          error: `Video generation failed: ${response.status} - ${errorText.substring(0, 200)}`,
          videoUrl: null,
        });
      }

      const altResult = await altResponse.json();
      return res.json({
        success: true,
        videoUrl: altResult.output?.url || altResult.video_url || altResult.url || null,
        taskId: altResult.task_id || altResult.id,
      });
    }

    const result = await response.json();

    if (result.task_id || result.id) {
      const taskId = result.task_id || result.id;
      console.log("Got task ID, polling for completion...");

      for (let attempts = 0; attempts < POLL_ATTEMPTS; attempts++) {
        await hooks.sleep(POLL_INTERVAL_MS);

        const statusResponse = await hooks.fetch(`${KIE}/api/v1/video/status/${encodeURIComponent(taskId)}`, {
          headers: { Authorization: auth },
          signal: AbortSignal.timeout(30_000),
        });

        if (statusResponse.ok) {
          const statusResult = await statusResponse.json();
          if (statusResult.status === "completed" || statusResult.status === "success") {
            const videoUrl = statusResult.video_url || statusResult.output?.url || statusResult.url;
            if (videoUrl) return res.json({ success: true, videoUrl });
          } else if (statusResult.status === "failed" || statusResult.status === "error") {
            console.error("Video generation failed:", statusResult.error || statusResult.message);
            return res.json({
              success: false,
              error: statusResult.error || "Video generation failed",
              videoUrl: null,
            });
          }
        }
      }

      return res.json({
        success: false,
        taskId,
        error: "Video generation in progress - check back later",
        videoUrl: null,
      });
    }

    const videoUrl = result.video_url || result.output?.url || result.url || null;
    return res.json({ success: true, videoUrl });
  } catch (error) {
    console.error("Error in generate-story-video:", error?.message);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
      videoUrl: null,
    });
  }
});
