// Port of supabase/functions/extract-answer-from-image. Sends an answer image to the configured
// vision model and returns the answer text. POST { image_url, question_context }, where image_url is a
// data: URL or an http(s) URL. Requires a signed-in user, because each call uses the admin's AI key.
import express from "express";
import { userIdFromBearer } from "../_shared/cdn-presentation-refresh-start-helper.js";
import { hookedFetch, loadAiEndpoint, postChat } from "../_shared/extract-dpp-helper.js";

export const router = express.Router();

const GOOGLE_FALLBACK_MODELS = ["gemini-2.5-flash-lite", "gemini-2.5-flash"];
const sendJson = (res, status, body) => res.status(status).type("application/json").send(JSON.stringify(body));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const SYSTEM_PROMPT = `You are an expert at reading handwritten and typed mathematical answers from images.
Your job is to extract the EXACT answer written in the image.

Rules:
1. Extract ONLY the answer, not the question or any other text
2. Preserve mathematical notation - use LaTeX format for equations (e.g., \\frac{1}{2}, x^2, \\sqrt{3})
3. If multiple answers are visible, extract the final/main answer (usually the last one or the one that's underlined/boxed)
4. For multiple choice questions, extract just the option letter (A, B, C, D) or the full answer text
5. For numerical answers, extract the exact number including units if visible
6. If the answer is unclear or partially visible, provide your best interpretation
7. Return "UNREADABLE" only if the image is completely unreadable (too blurry, too dark, or no text visible)

Important: Return ONLY the extracted answer as plain text or LaTeX. Do not include any explanations or additional text.`;

function visionBody(model, userPrompt, imageDataUrl) {
  return {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: userPrompt },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
    max_tokens: 500,
    temperature: 0.1,
  };
}

router.post("/", async (req, res) => {
  const userId = userIdFromBearer(req);
  if (!userId) return sendJson(res, 401, { error: "Unauthorized" });

  try {
    const { image_url: imageUrl, question_context: questionContext } = req.body || {};
    if (!imageUrl) return sendJson(res, 400, { error: "image_url is required" });

    const endpoint = await loadAiEndpoint();
    if (!endpoint) {
      console.error("No valid AI API configuration found");
      return sendJson(res, 503, { error: "AI API not configured. Please configure your API key in Admin Settings." });
    }

    // Remote images must be plain http(s) URLs.
    let imageDataUrl;
    if (imageUrl.startsWith("data:")) {
      imageDataUrl = imageUrl;
    } else {
      if (!/^https?:\/\//i.test(imageUrl)) return sendJson(res, 400, { error: "Invalid image_url" });
      const imageResponse = await hookedFetch(imageUrl);
      if (!imageResponse.ok) {
        return sendJson(res, 400, { error: `Failed to fetch image: ${imageResponse.status}` });
      }
      const contentType = imageResponse.headers.get("content-type") || "image/jpeg";
      const base64 = Buffer.from(await imageResponse.arrayBuffer()).toString("base64");
      const mimeType = contentType.split(";")[0].trim();
      imageDataUrl = `data:${mimeType};base64,${base64}`;
    }

    const userPrompt = questionContext
      ? `Extract the answer from this image. The question context is: "${questionContext}"\n\nProvide only the answer, nothing else.`
      : "Extract the answer from this image. Provide only the answer, nothing else.";

    let response = await postChat(endpoint, visionBody(endpoint.model, userPrompt, imageDataUrl));

    // One retry on the same model for 503 and 429.
    if (response.status === 503 || response.status === 429) {
      await response.text();
      await pause(2000);
      response = await postChat(endpoint, visionBody(endpoint.model, userPrompt, imageDataUrl));
    }

    // Google: try the fallback models when still overloaded.
    if ((response.status === 503 || response.status === 429) && endpoint.provider === "google") {
      for (const fallbackModel of GOOGLE_FALLBACK_MODELS) {
        if (fallbackModel === endpoint.model) continue;
        await response.text();
        await pause(1000);
        response = await postChat(endpoint, visionBody(fallbackModel, userPrompt, imageDataUrl));
        if (response.ok) break;
      }
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error("AI API error:", response.status, errorText.slice(0, 300));
      if (response.status === 429) {
        return sendJson(res, 429, { error: "Rate limit exceeded. Please try again later." });
      }
      if (response.status === 401 || response.status === 403) {
        return sendJson(res, response.status, { error: "Invalid or unauthorized API key." });
      }
      return sendJson(res, 500, { error: "Failed to process image" });
    }

    const data = await response.json();
    const extractedText = data.choices?.[0]?.message?.content?.trim() || "";

    let confidence = "medium";
    if (extractedText === "UNREADABLE" || extractedText === "") {
      confidence = "low";
    } else if (extractedText.length < 100) {
      confidence = "high";
    }

    return sendJson(res, 200, { extracted_text: extractedText, confidence });
  } catch (error) {
    console.error("Error in extract-answer-from-image:", error.message);
    return sendJson(res, 500, { error: error instanceof Error ? error.message : "Unknown error occurred" });
  }
});

