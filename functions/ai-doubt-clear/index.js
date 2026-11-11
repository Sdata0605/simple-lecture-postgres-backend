// Port of supabase/functions/ai-doubt-clear. Answers one student doubt strictly from the topic's
// context. Step A is a relevance classifier (greetings and off-topic questions are refused); step B
// answers with the topic context only. Every answered or refused doubt is logged to doubt_logs.
//
// POST /functions/v1/ai-doubt-clear
// body: { question, topic_id, student_id }
// reply: { answer, out_of_syllabus? }  or  { error }
import express from "express";
import { query } from "../_shared/db.js";
import { loadAiApiConfig, pickProvider } from "../_shared/ai-check-answer-helper.js";

export const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GREETING_RE =
  /^\s*(hi+|hello+|hey+|yo|sup|test+|ok(ay)?|thanks?|thank\s*you|good\s*(morning|afternoon|evening|night)|how\s*are\s*you|who\s*are\s*you|what'?s\s*up)[\s!.?]*$/i;

function buildRefusal(topicTitle, chapterTitle) {
  return `I'd love to help, but this question doesn't seem to be part of the current topic "${topicTitle}"${
    chapterTitle ? ` in ${chapterTitle}` : ""
  }. Please ask something related to this topic, or head over to the Forum for general questions. 🙏`;
}

const refusalResponse = (res, answer) => res.json({ answer, out_of_syllabus: true });

// Logs a doubt. Failures are ignored, as in the original.
async function logDoubt(row) {
  try {
    await query(
      `INSERT INTO public.doubt_logs
         (student_id, topic_id, question, answer, context_used, model_used, response_time_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.student_id, row.topic_id, row.question, row.answer, row.context_used, row.model_used, row.response_time_ms]
    );
  } catch (e) {
    console.error("[ai-doubt-clear] doubt log failed:", String(e?.message ?? e).slice(0, 200));
  }
}

router.post("/", async (req, res) => {
  const startedAt = Date.now();
  try {
    const { question, topic_id, student_id } = req.body ?? {};

    if (!question || !topic_id || !student_id) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Topic context (topic -> chapter -> course).
    if (typeof topic_id !== "string" || !UUID_RE.test(topic_id)) throw new Error("Topic not found");
    const { rows } = await query(
      `SELECT t.title, t.content_markdown, c.title AS chapter_title, c.description AS chapter_description,
              co.name AS course_name
         FROM public.topics t
         LEFT JOIN public.chapters c ON c.id = t.chapter_id
         LEFT JOIN public.courses co ON co.id = c.course_id
        WHERE t.id = $1`,
      [topic_id]
    );
    const topic = rows[0];
    if (!topic) throw new Error("Topic not found");

    const topicTitle = topic.title || "this topic";
    const chapterTitle = topic.chapter_title || "";

    // Pre-flight: short, greeting or smalltalk is refused without calling the model.
    const trimmed = String(question).trim();
    if (trimmed.length < 5 || GREETING_RE.test(trimmed)) {
      return refusalResponse(res, buildRefusal(topicTitle, chapterTitle));
    }

    const context = `
Topic: ${topic.title}
Chapter: ${topic.chapter_title || ""}
Course: ${topic.course_name || ""}
Content: ${topic.content_markdown || "No detailed content available"}
Description: ${topic.chapter_description || ""}
`;

    const provider = pickProvider(await loadAiApiConfig());
    if (!provider) {
      console.error("No valid AI API configuration found");
      return res.status(503).json({
        error: "AI API not configured. Please go to Admin → Settings → AI Functions API Key Settings to add your API key.",
      });
    }
    const { apiUrl, apiKey, model } = provider;

    // STEP A: relevance classifier
    const classifyRes = await fetch(apiUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: `You are a strict relevance classifier for a school LMS. Decide if the student's question is answerable using ONLY the provided topic context (topic title, chapter, course, content).

Return ONLY minified JSON: {"relevant": true|false, "confidence": 0.0-1.0}

Rules:
- Greetings, smalltalk, "hi/hello/test/thanks" => relevant=false
- Questions about a different subject or clearly outside the topic => relevant=false
- Questions requiring knowledge not present or implied by the context => relevant=false
- Only mark true when the question is clearly about the given topic/chapter.
No prose, no code fences — JSON only.`,
          },
          { role: "user", content: `Topic context:\n${context}\n\nStudent question: ${trimmed}` },
        ],
        temperature: 0,
        response_format: { type: "json_object" },
      }),
    });

    let relevant = false;
    let confidence = 0;
    if (classifyRes.ok) {
      try {
        const cJson = await classifyRes.json();
        const raw = cJson.choices?.[0]?.message?.content ?? "{}";
        const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
        relevant = parsed.relevant === true;
        confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
      } catch {
        console.error("Classifier parse error");
      }
    } else {
      console.error("Classifier call failed:", classifyRes.status);
    }

    if (!relevant || confidence < 0.6) {
      const refusal = buildRefusal(topicTitle, chapterTitle);
      await logDoubt({
        student_id,
        topic_id,
        question: trimmed,
        answer: refusal,
        context_used: context.substring(0, 500),
        model_used: "guardrail",
        response_time_ms: Date.now() - startedAt,
      });
      return refusalResponse(res, refusal);
    }

    // STEP B: answer strictly from the topic context
    const refusalText = buildRefusal(topicTitle, chapterTitle);
    const aiResponse = await fetch(apiUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: `You are an expert AI tutor for SimpleLecture. Answer the student's question using ONLY the following topic context. If the context does not contain enough information to answer, respond with EXACTLY this text and nothing else:

"${refusalText}"

Topic context:
${context}

Guidelines when you can answer:
- Clear, step-by-step explanations in simple language
- Reference the course material
- Be encouraging and patient
- Never invent facts outside the context`,
          },
          { role: "user", content: trimmed },
        ],
        temperature: 0.7,
      }),
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
    const answer = aiData.choices[0].message.content;

    await logDoubt({
      student_id,
      topic_id,
      question: trimmed,
      answer,
      context_used: context.substring(0, 500),
      model_used: model,
      response_time_ms: Date.now() - startedAt,
    });

    return res.json({ answer });
  } catch (error) {
    console.error("Error in ai-doubt-clear:", String(error?.message ?? error).slice(0, 200));
    const errorMessage = error instanceof Error ? error.message : "An unexpected error occurred";
    return res.status(500).json({ error: errorMessage });
  }
});

export default router;
