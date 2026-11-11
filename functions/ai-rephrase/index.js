// Port of supabase/functions/ai-rephrase. Rephrases a chapter, topic, question, answer or explanation,
// returning one or more variants.
//
// POST /functions/v1/ai-rephrase
// body: { text, type, prompt?, count? (1-5) }
// reply: { original, rephrased, suggestions, type }
import express from "express";
import { callAI, loadAiApiConfig, pickProvider } from "../_shared/ai-check-answer-helper.js";

export const router = express.Router();

const SYSTEM_PROMPTS = {
  chapter:
    "You are an expert educational content writer. Rephrase the given chapter title to make it more clear, engaging, and academically appropriate. Keep it concise (under 100 characters). Return only the rephrased text, nothing else.",
  topic:
    "You are an expert educational content writer. Rephrase the given topic title to make it more clear, engaging, and academically appropriate. Keep it concise (under 100 characters). Return only the rephrased text, nothing else.",
  question:
    "You are an expert in educational assessment. Rephrase the given question to make it clearer, more precise, and better formatted. Maintain the same difficulty level and intent. Return only the rephrased question, nothing else.",
  answer:
    "You are an expert in educational content. Rephrase the given answer to make it more clear and concise while maintaining accuracy. Return only the rephrased answer, nothing else.",
  explanation:
    "You are an expert educator. Rephrase the given explanation to make it clearer and more helpful for students. Keep it informative but accessible. Return only the rephrased explanation, nothing else.",
};

router.post("/", async (req, res) => {
  try {
    const { text, type, prompt, count } = req.body ?? {};

    if (!text || !type) {
      return res.status(400).json({ error: "Missing required fields: text and type" });
    }

    const variantCount = Math.min(Math.max(Number(count) || 1, 1), 5);
    const customInstructions = typeof prompt === "string" && prompt.trim().length > 0 ? prompt.trim() : null;

    const provider = pickProvider(await loadAiApiConfig());
    if (!provider) {
      console.error("No valid AI API configuration found");
      return res.status(503).json({
        error: "AI API not configured. Please go to Admin → Settings → AI Functions API Key Settings to add your API key.",
      });
    }

    const systemPrompt = SYSTEM_PROMPTS[type] || SYSTEM_PROMPTS.question;

    const response = await callAI(
      provider.apiUrl,
      provider.apiKey,
      provider.model,
      `${systemPrompt}\n\nWhen multiple suggestions are requested, return ONLY a pure JSON array of strings (no markdown, no code fences).`,
      `Original Text:\n${text}\n\n${
        customInstructions ? `Additional Instructions:\n${customInstructions}\n\n` : ""
      }Please provide ${variantCount} high-quality rephrased variant${variantCount > 1 ? "s" : ""}. Keep within constraints.`,
      { temperature: 0.7 }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("AI Gateway error:", response.status, errorText.slice(0, 200));
      if (response.status === 429) {
        return res.status(429).json({ error: "Rate limit exceeded. Please try again later." });
      }
      if (response.status === 401 || response.status === 403) {
        return res.status(response.status).json({
          error: "Invalid or unauthorized API key. Please check your API key in Admin Settings.",
        });
      }
      throw new Error(`AI provider error: ${response.status}`);
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content?.trim();
    if (!raw) throw new Error("No response from AI");

    let suggestions = [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        suggestions = parsed.map((s) => String(s).trim()).filter(Boolean);
      }
    } catch {
      // Fallback: single suggestion
    }
    if (suggestions.length === 0) suggestions = [raw];

    return res.json({
      original: text,
      rephrased: suggestions[0],
      suggestions,
      type,
    });
  } catch (error) {
    console.error("Error in ai-rephrase function:", String(error?.message ?? error).slice(0, 200));
    return res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

export default router;
