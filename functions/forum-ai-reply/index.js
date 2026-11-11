// Port of supabase/functions/forum-ai-reply. Writes an AI answer to forum posts.
//   { postId }            : answer one post.
//   { checkOnly: true }   : answer every published, unanswered post in a general category that is
//                           older than 10 minutes (run by a cron job).
// Auth: a valid user Bearer token, or the x-service-key header matching SERVICE_KEY (for cron).
// The AI provider comes from ai_settings 'ai_api_config', as in the other AI functions.
import express from "express";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { query } from "../_shared/db.js";

export const router = express.Router();

// Test hook: lets tests stub the AI provider so no real request is sent.
export const hooks = { fetch: (...args) => fetch(...args) };

const SYSTEM_PROMPT = `You are a helpful AI assistant for an educational LMS forum.
Your role is to:
- Answer student questions clearly and concisely
- Provide accurate information about the LMS platform
- Be friendly and encouraging
- If you don't know something specific about the platform, acknowledge that and provide general guidance
- Keep responses focused and not too long (2-3 paragraphs max)`;

function isAuthorised(req) {
  const svc = process.env.SERVICE_KEY || "";
  const got = req.get("x-service-key") || "";
  if (svc && got.length === svc.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(svc))) return true;
  const h = req.get("Authorization") || "";
  if (!h.startsWith("Bearer ")) return false;
  try {
    return Boolean(jwt.verify(h.slice(7), process.env.JWT_SECRET)?.sub);
  } catch {
    return false;
  }
}

// Same provider selection as llm-verify-questions.
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

// Writes one AI reply. Errors are logged and swallowed, as in the original.
async function generateAIReply(postId, title, content, provider) {
  console.log(`Generating AI reply for post: ${postId}`);
  const userPrompt = `Please answer this forum question:

Title: ${title}

Question: ${content}`;
  try {
    const response = await hooks.fetch(provider.apiUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      console.error("AI Gateway error:", response.status);
      return;
    }
    const data = await response.json();
    const aiResponse = data.choices?.[0]?.message?.content;
    if (!aiResponse) {
      console.error("No response content from AI");
      return;
    }
    await query(
      `INSERT INTO public.forum_replies (post_id, author_id, content, is_ai_generated, status)
       VALUES ($1, NULL, $2, true, 'published')`,
      [postId, aiResponse],
    );
    console.log(`AI reply created for post: ${postId}`);
  } catch (error) {
    console.error("Error generating AI reply:", error?.message);
  }
}

router.post("/", async (req, res) => {
  try {
    if (!isAuthorised(req)) return res.status(401).json({ error: "Unauthorized" });
    const { postId, checkOnly } = req.body || {};

    const provider = pickProvider(
      (await query("SELECT setting_value FROM public.ai_settings WHERE setting_key = 'ai_api_config' LIMIT 1")).rows[0]
        ?.setting_value,
    );
    if (!provider) {
      console.error("No valid AI API configuration found");
      return res.status(503).json({
        error: "AI API not configured. Please configure your API key in Admin Settings.",
      });
    }

    if (checkOnly) {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { rows: unanswered } = await query(
        `SELECT p.id, p.title, p.content, p.created_at
           FROM public.forum_posts p
           JOIN public.forum_categories c ON c.id = p.category_id
          WHERE p.is_answered = false AND p.status = 'published'
            AND p.created_at < $1 AND c.is_general = true`,
        [tenMinutesAgo],
      );
      console.log(`Found ${unanswered.length} unanswered general posts`);
      for (const post of unanswered) {
        await generateAIReply(post.id, post.title, post.content, provider);
      }
      return res.json({ processed: unanswered.length });
    }

    if (!postId) throw new Error("postId is required");

    const { rows } = await query("SELECT id, title, content FROM public.forum_posts WHERE id = $1", [postId]);
    if (!rows[0]) throw new Error("Post not found");

    await generateAIReply(rows[0].id, rows[0].title, rows[0].content, provider);
    res.json({ success: true });
  } catch (error) {
    console.error("Error in forum-ai-reply:", error?.message);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});
