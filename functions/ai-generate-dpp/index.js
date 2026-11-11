// Port of supabase/functions/ai-generate-dpp. Generates exactly 10 MCQs for one subject topic from its
// reference documentation, using a forced tool call so the answer is structured. Nothing is saved here.
//
// POST /functions/v1/ai-generate-dpp
// body: { topic_id }
import express from "express";
import { query } from "../_shared/db.js";
import { loadAiApiConfig, pickProvider } from "../_shared/ai-check-answer-helper.js";

export const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SYSTEM_PROMPT = `You are an expert educational content creator. Generate exactly 10 high-quality multiple choice questions (MCQs) based on the provided topic and documentation.

IMPORTANT RULES:
1. Generate EXACTLY 10 questions - no more, no less
2. Each question must have exactly 4 options labeled A, B, C, D
3. Only ONE option should be correct
4. Questions should test understanding, not just memorization
5. Include a mix of difficulty levels (easy, medium, hard)
6. Provide a brief explanation for each correct answer`;

const SUBMIT_TOOL = {
  type: "function",
  function: {
    name: "submit_questions",
    description: "Submit the generated MCQ questions",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "number" },
              question: { type: "string" },
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", enum: ["A", "B", "C", "D"] },
                    text: { type: "string" },
                  },
                  required: ["id", "text"],
                  additionalProperties: false,
                },
              },
              correctAnswer: { type: "string", enum: ["A", "B", "C", "D"] },
              explanation: { type: "string" },
              difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
            },
            required: ["id", "question", "options", "correctAnswer", "explanation", "difficulty"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
  },
};

router.post("/", async (req, res) => {
  try {
    const { topic_id } = req.body ?? {};
    if (!topic_id) {
      return res.status(400).json({ error: "topic_id is required" });
    }

    console.log("Edge function called with topic_id:", topic_id);

    if (typeof topic_id !== "string" || !UUID_RE.test(topic_id)) {
      return res.status(500).json({
        error: "Failed to fetch topic",
        details: { code: "22P02", message: "invalid input syntax for type uuid" },
      });
    }

    // 1. Topic
    let topic;
    try {
      const r = await query("SELECT id, title, chapter_id, content_markdown, notes_markdown FROM public.subject_topics WHERE id = $1", [
        topic_id,
      ]);
      topic = r.rows[0] ?? null;
    } catch (e) {
      console.error("Error fetching topic:", String(e.message).slice(0, 200));
      return res.status(500).json({ error: "Failed to fetch topic", details: { code: e.code, message: e.message } });
    }
    if (!topic) {
      console.error("Topic not found with id:", topic_id);
      return res.status(404).json({ error: "Topic not found", topic_id });
    }

    // 2. Chapter and subject (a failure here is only logged, as in the original)
    let chapter = null;
    let subject = null;
    if (topic.chapter_id) {
      try {
        const c = await query("SELECT id, title, subject_id FROM public.subject_chapters WHERE id = $1", [topic.chapter_id]);
        chapter = c.rows[0] ?? null;
        if (chapter?.subject_id) {
          const s = await query("SELECT id, name FROM public.popular_subjects WHERE id = $1", [chapter.subject_id]);
          subject = s.rows[0] ?? null;
        }
      } catch (e) {
        console.warn("Error fetching chapter or subject:", String(e.message).slice(0, 200));
      }
    }

    // 3. Documentation for the topic
    let docs = [];
    try {
      const d = await query(
        "SELECT full_content, content_preview, display_name FROM public.ai_assistant_documents WHERE topic_id = $1 AND status = 'active'",
        [topic_id]
      );
      docs = d.rows;
    } catch (e) {
      console.error("Error fetching documents:", String(e.message).slice(0, 200));
    }

    let documentContext = "";
    if (docs.length > 0) {
      documentContext = docs
        .map((d) => {
          if (d.full_content) {
            return typeof d.full_content === "string" ? d.full_content : JSON.stringify(d.full_content);
          }
          return d.content_preview || "";
        })
        .filter(Boolean)
        .join("\n\n");
    }
    if (topic.content_markdown) documentContext = topic.content_markdown + "\n\n" + documentContext;
    if (topic.notes_markdown) documentContext = topic.notes_markdown + "\n\n" + documentContext;

    const topicContext = `
Topic: ${topic?.title || "Unknown Topic"}
Chapter: ${chapter?.title || "Unknown Chapter"}
Subject: ${subject?.name || "Unknown Subject"}
    `.trim();

    const userPrompt = `Generate 10 MCQ questions for the following topic:

${topicContext}

${
  documentContext
    ? `\nReference Documentation:\n${documentContext.substring(0, 15000)}`
    : "\nNo documentation available - generate questions based on the topic name and general knowledge of the subject."
}`;

    const provider = pickProvider(await loadAiApiConfig());
    if (!provider) {
      console.error("No valid AI API configuration found");
      return res.status(503).json({
        error: "AI API not configured. Please go to Admin → Settings → AI Functions API Key Settings to add your API key.",
      });
    }

    const aiResponse = await fetch(provider.apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        tools: [SUBMIT_TOOL],
        tool_choice: { type: "function", function: { name: "submit_questions" } },
      }),
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error("AI API error:", aiResponse.status, errorText.slice(0, 200));
      if (aiResponse.status === 429) {
        return res.status(429).json({ error: "Rate limit exceeded. Please try again later." });
      }
      if (aiResponse.status === 402) {
        return res.status(402).json({ error: "AI credits exhausted. Please contact support." });
      }
      return res.status(500).json({ error: "Failed to generate questions" });
    }

    const aiData = await aiResponse.json();

    let questions;
    try {
      const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
      if (!toolCall || toolCall.function.name !== "submit_questions") {
        console.error("No valid tool call in response");
        throw new Error("AI did not return questions via tool call");
      }
      const args = JSON.parse(toolCall.function.arguments);
      questions = args.questions;
      if (!Array.isArray(questions) || questions.length === 0) {
        throw new Error("Invalid questions format");
      }
      if (questions.length > 10) questions = questions.slice(0, 10);
      console.log(`Successfully parsed ${questions.length} questions`);
    } catch (parseError) {
      console.error("Error parsing AI response:", String(parseError?.message ?? parseError).slice(0, 200));
      return res.status(500).json({ error: "Failed to parse generated questions" });
    }

    return res.json({
      questions,
      topic: {
        id: topic?.id,
        title: topic?.title,
        chapter: chapter?.title,
        subject: subject?.name,
      },
    });
  } catch (error) {
    console.error("Error in ai-generate-dpp:", String(error?.message ?? error).slice(0, 200));
    return res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

export default router;
