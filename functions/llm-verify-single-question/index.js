// Port of supabase/functions/llm-verify-single-question. Verifies one pending question with the
// configured AI provider and saves the verdict on that row. Auth: Bearer user token (the original
// relied on the platform JWT gate).
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";

export const router = express.Router();

// Test hook: lets tests stub the AI provider so no real request is sent.
export const hooks = { fetch: (...args) => fetch(...args) };

function hasValidBearer(req) {
  const h = req.get("Authorization") || "";
  if (!h.startsWith("Bearer ")) return false;
  try {
    return Boolean(jwt.verify(h.slice(7), process.env.JWT_SECRET)?.sub);
  } catch {
    return false;
  }
}

// Same provider selection as llm-verify-questions.
function pickProvider(config) {
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
    const questionId = req.body?.questionId;
    console.log("Verifying question with LLM:", questionId);

    const { rows: qRows } = await query(
      "SELECT * FROM public.parsed_questions_pending WHERE id = $1",
      [questionId],
    );
    const question = qRows[0];
    if (!question) throw new Error("Question not found");

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

    const verificationPrompt = `Verify the following educational question for correctness and quality:

Question: ${question.question_text}
Type: ${question.question_format}
${question.options ? `Options: ${JSON.stringify(question.options)}` : ""}
Correct Answer: ${question.correct_answer}
${question.explanation ? `Solution: ${question.explanation}` : ""}

Evaluate:
1. Is the question clear and well-formed?
2. Are the options (if any) distinct and appropriate?
3. Is the correct answer accurate?
4. Is the solution (if provided) correct and clear?
5. Are there any mathematical, factual, or logical errors?

Respond ONLY with a JSON object in this exact format:
{
  "status": "correct" | "medium" | "wrong",
  "confidence": 0.0-1.0,
  "comments": "brief explanation",
  "issues": ["list", "of", "issues"] or []
}`;

    const aiResponse = await hooks.fetch(provider.apiUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          {
            role: "system",
            content: "You are an expert educator who verifies educational content for accuracy. Always respond with valid JSON only.",
          },
          { role: "user", content: verificationPrompt },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!aiResponse.ok) {
      console.error("AI error:", aiResponse.status);
      throw new Error(`AI verification failed: ${aiResponse.status}`);
    }

    const aiData = await aiResponse.json();
    const responseText = aiData.choices[0].message.content;
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Invalid AI response format");
    const verification = JSON.parse(jsonMatch[0]);

    await query(
      `UPDATE public.parsed_questions_pending
          SET llm_verification_status = $2,
              llm_confidence_score = $3,
              llm_verification_comments = $4,
              llm_issues = $5,
              llm_verified_at = now(),
              llm_verified = true
        WHERE id = $1`,
      [
        questionId,
        verification.status,
        verification.confidence,
        verification.comments,
        verification.issues === undefined ? null : JSON.stringify(verification.issues),
      ],
    );

    res.json({ success: true, verification });
  } catch (error) {
    console.error("Error verifying question:", error?.message);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});
