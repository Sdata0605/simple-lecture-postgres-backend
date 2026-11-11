// Port of supabase/functions/bulk-auto-assign-chapters. Asks the configured AI provider to place each
// unassigned question of an uploaded document into a chapter, topic, and subtopic of its subject.
// POST { documentId }. Callers: an admin (Bearer JWT with the admin role) or x-service-key = SERVICE_KEY.
// The original had no check of its own; the admin/service check is added here.
// Note: the original read topics with subject_id, a column subject_topics does not have, so topics were
// always empty. Topics are now taken from the subject's chapters.
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";

export const router = express.Router();

async function allowed(req) {
  const key = process.env.SERVICE_KEY;
  if (key && req.headers["x-service-key"] === key) return true;
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  let userId = null;
  try {
    userId = jwt.verify(token, process.env.JWT_SECRET)?.sub || null;
  } catch {
    return false;
  }
  if (!userId) return false;
  const { rows } = await query("SELECT has_role($1::uuid, 'admin'::app_role) AS ok", [userId]);
  return !!rows[0]?.ok;
}

async function aiEndpoint() {
  const { rows } = await query("SELECT setting_value FROM public.ai_settings WHERE setting_key = $1 LIMIT 1", ["ai_api_config"]);
  const config = rows[0]?.setting_value || null;
  if (config?.enabled && config.provider === "openrouter" && config.openrouter_api_key) {
    return {
      apiUrl: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: config.openrouter_api_key,
      model: config.default_model || "google/gemini-2.5-flash",
    };
  }
  if (config?.enabled && config.provider === "google" && config.google_api_key) {
    return {
      apiUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      apiKey: config.google_api_key,
      model: config.default_model || "gemini-2.5-flash",
    };
  }
  if (config?.enabled && config.provider === "openai" && config.openai_api_key) {
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
    if (!(await allowed(req))) return res.status(401).json({ error: "Unauthorized" });

    const documentId = req.body?.documentId;
    if (!documentId) return res.status(400).json({ error: "documentId is required" });

    const ai = await aiEndpoint();
    if (!ai) {
      console.error("No valid AI API configuration found");
      return res.status(503).json({ error: "AI API not configured. Please configure your API key in Admin Settings." });
    }

    const { rows: docRows } = await query(
      `SELECT d.*, c.name AS category_name, s.name AS subject_name
         FROM public.uploaded_question_documents d
         LEFT JOIN public.categories c ON c.id = d.category_id
         LEFT JOIN public.popular_subjects s ON s.id = d.subject_id
        WHERE d.id = $1`,
      [documentId]
    );
    const document = docRows[0];
    if (!document) throw new Error("Document not found");

    const { rows: questions } = await query(
      `SELECT * FROM public.parsed_questions_pending
        WHERE document_id = $1 AND (chapter_id IS NULL OR topic_id IS NULL)`,
      [documentId]
    );
    if (questions.length === 0) {
      return res.json({ message: "No unassigned questions found", assignedCount: 0 });
    }

    const { rows: chapters } = await query(
      "SELECT id, title, description FROM public.subject_chapters WHERE subject_id = $1",
      [document.subject_id]
    );
    const { rows: topics } = await query(
      `SELECT id, title, description, chapter_id FROM public.subject_topics
        WHERE chapter_id IN (SELECT id FROM public.subject_chapters WHERE subject_id = $1)`,
      [document.subject_id]
    );
    const { rows: subtopics } = topics.length
      ? await query(
          "SELECT id, title, description, topic_id FROM public.subtopics WHERE topic_id = ANY($1::uuid[])",
          [topics.map((t) => t.id)]
        )
      : { rows: [] };

    let assignedCount = 0;
    const results = [];

    for (const question of questions) {
      try {
        const systemPrompt =
          "You are an expert educational content classifier. Analyze the question and suggest the most appropriate chapter, topic, and subtopic. Return a JSON object.";
        const userPrompt = `Question: ${question.question_text}

Subject: ${document.subject_name}
Category: ${document.category_name}

Available Chapters:
${JSON.stringify(chapters, null, 2)}

Available Topics:
${JSON.stringify(topics, null, 2)}

Available Subtopics:
${JSON.stringify(subtopics, null, 2)}

Suggest the best match. Return JSON with: {"chapterId": "uuid", "topicId": "uuid", "subtopicId": "uuid or null", "confidence": 0.0-1.0, "reasoning": "text"}`;

        const response = await fetch(ai.apiUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${ai.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: ai.model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            temperature: 0.7,
            response_format: { type: "json_object" },
          }),
        });

        if (response.ok) {
          const data = await response.json();
          const suggestion = JSON.parse(data.choices[0].message.content);
          try {
            await query(
              `UPDATE public.parsed_questions_pending
                  SET chapter_id = $2, topic_id = $3, subtopic_id = $4, instructor_comments = $5
                WHERE id = $1`,
              [
                question.id,
                suggestion.chapterId,
                suggestion.topicId,
                suggestion.subtopicId || null,
                `AI Auto-assigned (confidence: ${suggestion.confidence}): ${suggestion.reasoning}`,
              ]
            );
            assignedCount++;
            results.push({ questionId: question.id, success: true, confidence: suggestion.confidence });
          } catch {
            // A failed update is not counted, as in the original.
          }
        }
      } catch (error) {
        console.error(`Error processing question ${question.id}:`, error?.message);
        results.push({
          questionId: question.id,
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }

      await new Promise((r) => setTimeout(r, 100));
    }

    return res.json({
      message: `Auto-assigned ${assignedCount} out of ${questions.length} questions`,
      assignedCount,
      totalQuestions: questions.length,
      results,
    });
  } catch (error) {
    console.error("Error in bulk-auto-assign-chapters:", error?.message);
    return res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});
