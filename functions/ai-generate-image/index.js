// Port of supabase/functions/ai-generate-image. Generates a course image through OpenRouter and stores
// it in the course-thumbnails bucket. Reply: { imageUrl }.
// The file is stored on this server (functions/_shared/storage.js). There is no public-object route,
// so imageUrl is a signed link valid for one year.
//
// POST /functions/v1/ai-generate-image
// body: { prompt, courseId? }
import express from "express";
import { loadAiApiConfig } from "../_shared/ai-check-answer-helper.js";
import { upload, createSignedUrl } from "../_shared/storage.js";

export const router = express.Router();

const BUCKET = "course-thumbnails";
const LINK_TTL_SEC = 365 * 24 * 3600;

router.post("/", async (req, res) => {
  try {
    const { prompt, courseId } = req.body ?? {};
    if (!prompt) throw new Error("Prompt is required");

    const config = await loadAiApiConfig();
    const openRouterApiKey = config?.openrouter_api_key?.trim?.();

    if (!config?.enabled || config.provider !== "openrouter" || !openRouterApiKey) {
      return res.status(503).json({
        error: "OpenRouter image generation is not configured. Enable OpenRouter and save its API key in Admin Settings.",
      });
    }

    console.log("Generating course image via OpenRouter");

    const response = await fetch("https://openrouter.ai/api/v1/images", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openRouterApiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.PUBLIC_SITE_URL || "https://simplelecture.com",
        "X-Title": "SimpleLecture",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-image",
        prompt,
        n: 1,
        aspect_ratio: "16:9",
        output_format: "png",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("OpenRouter image API error:", response.status, errorText.slice(0, 300));
      if (response.status === 429) {
        return res.status(429).json({ error: "Rate limit exceeded. Please try again later." });
      }
      if (response.status === 401 || response.status === 403) {
        return res
          .status(response.status)
          .json({ error: "OpenRouter rejected the API key. Please check the key in Admin Settings." });
      }
      if (response.status === 402) {
        return res
          .status(402)
          .json({ error: "The OpenRouter account does not have enough credits for image generation." });
      }
      throw new Error(`OpenRouter image API returned ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const b64 = data?.data?.[0]?.b64_json;
    const mediaType = data?.data?.[0]?.media_type || "image/png";

    if (!b64) {
      console.error("No image in OpenRouter response");
      throw new Error("No image was generated");
    }

    const bytes = Buffer.from(String(b64).replace(/^data:image\/\w+;base64,/, "").replace(/\s/g, ""), "base64");

    const folderPath = courseId || "temp";
    const extension = mediaType === "image/jpeg" ? "jpg" : mediaType === "image/webp" ? "webp" : "png";
    const fileName = `${folderPath}/ai_${Date.now()}.${extension}`;

    // courseId and the extension come from the request or the provider, so reject anything unsafe.
    if (!/^[A-Za-z0-9_-]+$/.test(folderPath)) throw new Error("Failed to upload image: invalid courseId");

    const uploaded = await upload(BUCKET, fileName, bytes);
    const imageUrl = createSignedUrl(BUCKET, uploaded.path, LINK_TTL_SEC);

    return res.json({ imageUrl });
  } catch (error) {
    console.error("Error in ai-generate-image function:", String(error?.message ?? error).slice(0, 200));
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: errorMessage });
  }
});

export default router;
