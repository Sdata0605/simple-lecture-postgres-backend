// Port of supabase/functions/ai-generate-mcqs. Generates MCQs for one topic with the admin-configured AI
// provider and saves them to public.questions. Reply: { questions: [...rows], message }.
//
// POST /functions/v1/ai-generate-mcqs
// body: { topic_id, difficulty?, count? (default 5) }
import express from "express";
import { query } from "../_shared/db.js";
import { callAI, loadAiApiConfig, pickProvider } from "../_shared/ai-check-answer-helper.js";

export const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post("/", async (req, res) => {
  try {
    const { topic_id, difficulty, count = 5 } = req.body ?? {};

    if (!topic_id) {
      return res.status(400).json({ error: "topic_id is required" });
    }

    const topicRows =
      typeof topic_id === "string" && UUID_RE.test(topic_id)
        ? (
            await query(
              `SELECT t.title, t.content_markdown, c.title AS chapter_title, c.description AS chapter_description,
                      c.subject AS chapter_subject
                 FROM public.topics t
                 LEFT JOIN public.chapters c ON c.id = t.chapter_id
                WHERE t.id = $1`,
              [topic_id]
            )
          ).rows
        : [];
    const topic = topicRows[0];
    if (!topic) throw new Error("Topic not found");

    const config = await loadAiApiConfig();
    const provider = pickProvider(config);
    if (!provider) {
      console.error("No valid AI API configuration found");
      return res.status(503).json({
        error: "AI API not configured. Please go to Admin → Settings → AI Functions API Key Settings to add your API key.",
      });
    }

    console.log(`Generating ${count} MCQs for topic:`, topic.title, "using:", config?.enabled ? config?.provider : "lovable");

    const systemPrompt = `You are an expert exam question generator for SimpleLecture.
Generate high-quality Multiple Choice Questions (MCQs) based on the provided content.

Topic: ${topic.title}
Chapter: ${topic.chapter_title ?? ""}
Subject: ${topic.chapter_subject ?? ""}
Difficulty: ${difficulty || "medium"}

Generate ${count} MCQs following this exact JSON format:
{
  "questions": [
    {
      "question_text": "Clear, unambiguous question text",
      "options": [
        {"id": "A", "text": "Option A text"},
        {"id": "B", "text": "Option B text"},
        {"id": "C", "text": "Option C text"},
        {"id": "D", "text": "Option D text"}
      ],
      "correct_answer": "A",
      "explanation": "Detailed explanation of why the correct answer is right"
    }
  ]
}

Guidelines:
- Questions should test conceptual understanding, not just memorization
- All options should be plausible
- Avoid "all of the above" or "none of the above"
- Provide clear, educational explanations
- Match the specified difficulty level`;

    const userContent = `Content:\n${
      topic.content_markdown || topic.chapter_description || "Generate questions based on the topic and chapter context."
    }`;

    const aiResponse = await callAI(provider.apiUrl, provider.apiKey, provider.model, systemPrompt, userContent, {
      temperature: 0.8,
    });

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error("AI Gateway error:", aiResponse.status, errorText.slice(0, 200));
      if (aiResponse.status === 429) {
        return res.status(429).json({ error: "Rate limit exceeded. Please try again later." });
      }
      throw new Error(`AI Gateway error: ${errorText}`);
    }

    const aiData = await aiResponse.json();
    const content = aiData.choices[0].message.content;

    let mcqData;
    try {
      const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/) || content.match(/```\n([\s\S]*?)\n```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : content;
      mcqData = JSON.parse(jsonStr);
    } catch {
      console.error("Failed to parse AI response");
      throw new Error("Failed to parse MCQ data from AI response");
    }

    const rowsToInsert = mcqData.questions.map((q) => [
      topic_id,
      q.question_text,
      "mcq",
      JSON.stringify(q.options ?? null),
      q.correct_answer,
      q.explanation ?? null,
      difficulty || "medium",
    ]);

    // One statement, so either all questions are saved or none are (as with supabase-js insert).
    const params = [];
    const placeholders = rowsToInsert.map((r) => {
      const start = params.length;
      params.push(...r);
      const idx = Array.from({ length: r.length }, (_, i) => `$${start + i + 1}`);
      return `(${idx.join(", ")})`;
    });
    const { rows: inserted } = await query(
      `INSERT INTO public.questions
         (topic_id, question_text, question_type, options, correct_answer, explanation, difficulty)
       VALUES ${placeholders.join(", ")}
       RETURNING *`,
      params
    );

    console.log(`Successfully generated and saved ${inserted.length} MCQs`);

    return res.json({
      questions: inserted,
      message: `Successfully generated ${inserted.length} MCQs`,
    });
  } catch (error) {
    console.error("Error in ai-generate-mcqs:", String(error?.message ?? error).slice(0, 200));
    const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred";
    return res.status(500).json({ error: errorMessage });
  }
});

export default router;
