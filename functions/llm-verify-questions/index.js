// Port of supabase/functions/llm-verify-questions. Sends pending questions to the configured AI
// provider (ai_settings 'ai_api_config': openrouter | google | openai) and saves the verdict on
// each parsed_questions_pending row. Questions the provider rejects are skipped, as in the original.
// Auth: Bearer user token (the original relied on the platform JWT gate).
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";

export const router = express.Router();

// Test hook: lets tests stub the AI provider so no real request is sent.
export const hooks = { fetch: (...args) => fetch(...args) };

const SYSTEM_PROMPT = `You are an expert educational content validator.

Analyze the question and verify:
1. Question clarity and grammar
2. Answer options quality
3. Correct answer accuracy
4. Explanation quality
5. **Difficulty level appropriateness** (is the assigned difficulty accurate?)

Respond with JSON:
{
  "status": "correct" | "medium" | "wrong",
  "confidence": 0.85,
  "comments": "Overall assessment",
  "issues": ["specific issues"],
  "difficulty_assessment": {
    "is_appropriate": true,
    "suggested_difficulty": "Medium",
    "reasoning": "Question requires multi-step calculation, appropriate for Medium"
  }
}`;

function hasValidBearer(req) {
  const h = req.get("Authorization") || "";
  if (!h.startsWith("Bearer ")) return false;
  try {
    return Boolean(jwt.verify(h.slice(7), process.env.JWT_SECRET)?.sub);
  } catch {
    return false;
  }
}

// Picks the provider from the saved config. Returns null when no provider is enabled with a key.
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

router.post("/", async (req, res) => {
  try {
    if (!hasValidBearer(req)) return res.status(401).json({ error: "Unauthorized" });
    const questionIds = req.body?.questionIds;

    const { rows: cfgRows } = await query(
      "SELECT setting_value FROM public.ai_settings WHERE setting_key = 'ai_api_config' LIMIT 1",
    );
    const provider = pickProvider(cfgRows[0]?.setting_value);
    if (!provider) {
      console.error("No valid AI API configuration found");
      return res.status(503).json({
        error: "AI API not configured. Please configure your API key in Admin Settings.",
      });
    }

    const ids = Array.isArray(questionIds) ? questionIds : [];
    const { rows: questions } = await query(
      "SELECT * FROM public.parsed_questions_pending WHERE id = ANY($1::uuid[])",
      [ids],
    );

    const verificationResults = [];
    for (const question of questions) {
      const userPrompt = `Question: ${question.question_text}
Format: ${question.question_format}
Options: ${JSON.stringify(question.options || {})}
Correct Answer: ${question.correct_answer}
Explanation: ${question.explanation || "None"}
Current Difficulty: ${question.difficulty}`;

      const aiResponse = await hooks.fetch(provider.apiUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: provider.model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          response_format: { type: "json_object" },
        }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!aiResponse.ok) {
        console.error("LLM verification failed:", aiResponse.status);
        continue;
      }

      const aiData = await aiResponse.json();
      const verification = JSON.parse(aiData.choices[0].message.content);

      await query(
        `UPDATE public.parsed_questions_pending
            SET llm_verified = true,
                llm_verification_status = $2,
                llm_confidence_score = $3,
                llm_verification_comments = $4,
                llm_issues = $5,
                llm_verified_at = now()
          WHERE id = $1`,
        [
          question.id,
          verification.status,
          verification.confidence,
          verification.comments,
          JSON.stringify(verification.issues || []),
        ],
      );

      verificationResults.push({
        questionId: question.id,
        status: verification.status,
        confidence: verification.confidence,
      });
    }

    res.json({ success: true, results: verificationResults });
  } catch (error) {
    console.error("Error verifying questions:", error?.message);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});
