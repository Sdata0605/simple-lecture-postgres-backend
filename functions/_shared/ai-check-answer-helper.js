// Shared AI helpers for the ai-* grading and tutoring functions. Ported from the identical
// blocks in supabase/functions/ai-check-answer, ai-compare-math-answers and ai-doubt-clear.
// Admin AI config lives in public.ai_settings under setting_key 'ai_api_config'. Keys are never logged.
import { query } from "./db.js";

// Loads the admin AI config row. Errors are ignored (same as the original's maybeSingle()).
export async function loadAiApiConfig() {
  try {
    const { rows } = await query(
      "SELECT setting_value FROM public.ai_settings WHERE setting_key = $1 LIMIT 1",
      ["ai_api_config"]
    );
    return rows[0]?.setting_value ?? null;
  } catch {
    return null;
  }
}

// Picks the endpoint, key and model for the configured provider, or null when AI is not set up.
export function pickProvider(config) {
  if (config?.enabled && config?.provider === "openrouter" && config?.openrouter_api_key) {
    return {
      apiUrl: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: config.openrouter_api_key,
      model: config.default_model || "google/gemini-2.5-flash",
    };
  }
  if (config?.enabled && config?.provider === "google" && config?.google_api_key) {
    return {
      apiUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      apiKey: config.google_api_key,
      model: config.default_model || "gemini-2.5-flash",
    };
  }
  if (config?.enabled && config?.provider === "openai" && config?.openai_api_key) {
    return {
      apiUrl: "https://api.openai.com/v1/chat/completions",
      apiKey: config.openai_api_key,
      model: config.default_model || "gpt-4o-mini",
    };
  }
  return null;
}

// One chat-completions call. Returns the fetch Response (the caller checks .ok).
// temperature defaults to 0.1; pass null to leave it out of the request (as some originals do).
export function callAI(apiUrl, apiKey, model, systemPrompt, userPrompt, { temperature = 0.1 } = {}) {
  return fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      ...(temperature === null ? {} : { temperature }),
    }),
  });
}

// Word-overlap similarity (0-100) used when no AI provider answers.
export function calculateSimpleSimilarity(str1, str2) {
  const words1 = new Set(str1.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const words2 = new Set(str2.toLowerCase().split(/\s+/).filter((w) => w.length > 2));

  if (words1.size === 0 && words2.size === 0) return 100;
  if (words1.size === 0 || words2.size === 0) return 0;

  let intersection = 0;
  for (const word of words1) {
    if (words2.has(word)) intersection++;
  }
  const union = words1.size + words2.size - intersection;
  return Math.round((intersection / union) * 100);
}
