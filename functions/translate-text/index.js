// Port of supabase/functions/translate-text. Translates English text into an Indian language with the
// admin-configured AI provider. POST { text, targetLanguage }. en-IN is returned unchanged.
// Requires a signed-in user (the AI call costs money; the original relied on the gateway JWT check).
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";

export const router = express.Router();

const LANGUAGE_NAMES = {
  "hi-IN": "Hindi",
  "ta-IN": "Tamil",
  "te-IN": "Telugu",
  "kn-IN": "Kannada",
  "ml-IN": "Malayalam",
  "bn-IN": "Bengali",
  "mr-IN": "Marathi",
  "gu-IN": "Gujarati",
  "pa-IN": "Punjabi",
  "or-IN": "Odia",
  "ur-IN": "Urdu",
  "as-IN": "Assamese",
  "sa-IN": "Sanskrit",
};

function signedInUser(req) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  try {
    return jwt.verify(token, process.env.JWT_SECRET).sub || null;
  } catch {
    return null;
  }
}

router.post("/", async (req, res) => {
  try {
    if (!signedInUser(req)) return res.status(401).json({ error: "Unauthorized" });

    const { text, targetLanguage } = req.body || {};
    if (!text) return res.status(400).json({ error: "text is required" });
    if (!targetLanguage) return res.status(400).json({ error: "targetLanguage is required" });

    if (targetLanguage === "en-IN") {
      return res.json({ translatedText: text, sourceLanguage: "en-IN", targetLanguage });
    }

    const languageName = LANGUAGE_NAMES[targetLanguage];
    if (!languageName) return res.status(400).json({ error: `Unsupported language: ${targetLanguage}` });

    console.log(`[TranslateText] Translating to ${languageName}`);

    const { rows } = await query("SELECT setting_value FROM public.ai_settings WHERE setting_key = 'ai_api_config' LIMIT 1");
    const config = rows[0]?.setting_value || null;

    let apiUrl;
    let apiKey;
    let model;
    if (config?.enabled && config?.provider === "openrouter" && config?.openrouter_api_key) {
      apiUrl = "https://openrouter.ai/api/v1/chat/completions";
      apiKey = config.openrouter_api_key;
      model = config.default_model || "google/gemini-2.5-flash";
    } else if (config?.enabled && config?.provider === "google" && config?.google_api_key) {
      apiUrl = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
      apiKey = config.google_api_key;
      model = config.default_model || "gemini-2.5-flash";
    } else if (config?.enabled && config?.provider === "openai" && config?.openai_api_key) {
      apiUrl = "https://api.openai.com/v1/chat/completions";
      apiKey = config.openai_api_key;
      model = config.default_model || "gpt-4o-mini";
    } else {
      console.error("[TranslateText] No valid AI API configuration found");
      return res.status(503).json({ error: "AI API not configured. Please configure your API key in Admin Settings." });
    }

    const translationResponse = await fetch(apiUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: `You are a professional translator. Translate English text to ${languageName} using the native script. Follow these rules strictly:
1. Use native script only (Devanagari for Hindi, Tamil script for Tamil, etc.)
2. Keep the meaning and context accurate
3. Do NOT include any English text in the output
4. Do NOT include transliteration - only native script
5. Return ONLY the translated text, nothing else
6. Preserve any mathematical formulas or equations as-is
7. Keep proper nouns close to original pronunciation in native script`,
          },
          { role: "user", content: String(text) },
        ],
        temperature: 0.1,
        max_tokens: 4096,
      }),
    });

    if (!translationResponse.ok) {
      console.error("[TranslateText] AI error: HTTP", translationResponse.status);
      return res.status(500).json({ error: "Translation API error" });
    }

    const responseData = await translationResponse.json();
    const translatedText = responseData.choices?.[0]?.message?.content?.trim();
    if (!translatedText) {
      console.error("[TranslateText] No translation returned");
      return res.status(500).json({ error: "Translation failed - no text returned" });
    }

    return res.json({ translatedText, sourceLanguage: "en-IN", targetLanguage });
  } catch (error) {
    console.error("[TranslateText] Server error:", error?.message);
    return res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  }
});

export default router;
