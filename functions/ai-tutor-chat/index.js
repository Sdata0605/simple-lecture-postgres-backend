// Port of supabase/functions/ai-tutor-chat. Streams a tutor reply from the provider configured in
// public.ai_settings ('ai_api_config'): OpenRouter, Google (Gemini OpenAI-compatible) or OpenAI.
// POST { messages, course_context? }. Responds with a text/event-stream copied from the provider.
import express from "express";
import { query } from "../_shared/db.js";

export const router = express.Router();

const SYSTEM_PROMPT = `You are an expert AI tutor for SimpleLecture, India's leading AI-powered learning platform.

Your role:
- Help students master concepts for board exams, entrance tests (NEET, JEE), and skill development
- Provide clear, step-by-step explanations
- Use simple language appropriate for students
- Encourage critical thinking and problem-solving
- Be patient, supportive, and motivating
- Relate concepts to real-world applications when possible
- Break down complex topics into digestible parts`;

router.post("/", async (req, res) => {
  try {
    const { messages, course_context } = req.body || {};
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages array is required" });
    }

    const { rows } = await query("SELECT setting_value FROM public.ai_settings WHERE setting_key = $1 LIMIT 1", ["ai_api_config"]);
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
      console.error("No valid AI API configuration found");
      return res.status(503).json({
        error: "AI API not configured. Please go to Admin → Settings → AI Functions API Key Settings to add your API key.",
      });
    }

    let systemPrompt = SYSTEM_PROMPT;
    if (course_context) systemPrompt += `\n\nCurrent learning context:\n${course_context}`;

    const aiResponse = await fetch(apiUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        temperature: 0.7,
        stream: true,
      }),
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error("AI Gateway error:", aiResponse.status);
      if (aiResponse.status === 429) {
        return res.status(429).json({ error: "Rate limit exceeded. Please try again later." });
      }
      if (aiResponse.status === 401 || aiResponse.status === 403) {
        return res.status(aiResponse.status).json({
          error: "Invalid or unauthorized API key. Please check your API key in Admin Settings.",
        });
      }
      throw new Error(`AI Gateway error: ${errorText}`);
    }

    res.status(200);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    for await (const chunk of aiResponse.body) {
      res.write(chunk);
    }
    return res.end();
  } catch (error) {
    console.error("Error in ai-tutor-chat:", error?.message);
    if (res.headersSent) return res.end();
    return res.status(500).json({ error: error instanceof Error ? error.message : "An unexpected error occurred" });
  }
});
