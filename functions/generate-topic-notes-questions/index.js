// Port of supabase/functions/generate-topic-notes-questions. Generates practice questions for one
// section of a topic's notes with the Lovable AI gateway (key in LOVABLE_API_KEY) and inserts them
// into public.questions, so they appear in the Notes tab and the Question Bank.
// Auth: Bearer user token (the original relied on the platform JWT gate).
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";

export const router = express.Router();

// Test hook: lets tests stub the AI gateway so no real request is sent.
export const hooks = { fetch: (...args) => fetch(...args) };

const AI_GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hasValidBearer(req) {
  const h = req.get("Authorization") || "";
  if (!h.startsWith("Bearer ")) return false;
  try {
    return Boolean(jwt.verify(h.slice(7), process.env.JWT_SECRET)?.sub);
  } catch {
    return false;
  }
}

// Checks the body the way the original zod schema did. Returns { data } or { fieldErrors }.
export function parseBody(body) {
  const fieldErrors = {};
  const b = body && typeof body === "object" ? body : {};
  const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);
  const addErr = (k, msg) => {
    (fieldErrors[k] ||= []).push(msg);
  };

  if (!isUuid(b.topic_id)) addErr("topic_id", "Invalid uuid");
  if (b.chapter_id != null && !isUuid(b.chapter_id)) addErr("chapter_id", "Invalid uuid");
  if (b.subject_id != null && !isUuid(b.subject_id)) addErr("subject_id", "Invalid uuid");
  if (typeof b.section_id !== "string" || b.section_id.length < 1) addErr("section_id", "Required");
  if (typeof b.section_title !== "string" || b.section_title.length < 1) addErr("section_title", "Required");
  if (b.section_text !== undefined && typeof b.section_text !== "string") addErr("section_text", "Expected string");
  if (b.key_points !== undefined && (!Array.isArray(b.key_points) || b.key_points.some((p) => typeof p !== "string"))) {
    addErr("key_points", "Expected array of strings");
  }
  let count = 5;
  if (b.count !== undefined) {
    if (!Number.isInteger(b.count) || b.count < 1 || b.count > 10) addErr("count", "Number must be between 1 and 10");
    else count = b.count;
  }
  if (Object.keys(fieldErrors).length) return { fieldErrors };
  return {
    data: {
      topic_id: b.topic_id,
      chapter_id: b.chapter_id ?? null,
      subject_id: b.subject_id ?? null,
      section_id: b.section_id,
      section_title: b.section_title,
      section_text: b.section_text ?? "",
      key_points: b.key_points ?? [],
      count,
    },
  };
}

// Builds one multi-row INSERT with numbered placeholders. Returns { text, params }.
export function buildInsert(table, columns, rows) {
  const params = [];
  const tuples = rows.map((row) => {
    const marks = columns.map((c) => {
      params.push(row[c] === undefined ? null : row[c]);
      return `$${params.length}`;
    });
    return `(${marks.join(", ")})`;
  });
  return {
    text: `INSERT INTO public.${table} (${columns.join(", ")}) VALUES ${tuples.join(", ")} RETURNING id`,
    params,
  };
}

function buildPrompt(input) {
  return `You are an expert exam-question writer for a school LMS.

Create exactly ${input.count} practice questions strictly grounded in the study material below.
- Mix ~60% multiple-choice (4 options, exactly one correct) and ~40% short-answer.
- Cover different difficulty levels (easy, medium, hard).
- No trick questions; align with what the material actually teaches.
- Keep language crisp; use LaTeX ($...$ or $$...$$) for any math/chemistry equations.

SECTION TITLE: ${input.section_title}

SECTION TEXT:
${(input.section_text || "").slice(0, 6000)}

KEY POINTS:
${(input.key_points || []).map((p, i) => `${i + 1}. ${p}`).join("\n")}

Respond with ONLY a JSON object matching this schema — no prose, no code fences:
{
  "questions": [
    {
      "question_text": "string",
      "question_type": "mcq" | "short_answer",
      "options": ["A","B","C","D"],           // required only for mcq
      "correct_answer": "string",              // for mcq, use the exact option text
      "explanation": "string",
      "difficulty": "easy" | "medium" | "hard"
    }
  ]
}`;
}

router.post("/", async (req, res) => {
  try {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing LOVABLE_API_KEY" });
    if (!hasValidBearer(req)) return res.status(401).json({ error: "Unauthorized" });

    const parsed = parseBody(req.body);
    if (parsed.fieldErrors) return res.status(400).json({ error: parsed.fieldErrors });
    const input = parsed.data;

    const aiRes = await hooks.fetch(AI_GATEWAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Lovable-API-Key": apiKey },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: "You output only valid JSON." },
          { role: "user", content: buildPrompt(input) },
        ],
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!aiRes.ok) {
      const details = await aiRes.text();
      return res.status(aiRes.status).json({ error: "AI gateway failed", status: aiRes.status, details });
    }

    const aiJson = await aiRes.json();
    const content = aiJson?.choices?.[0]?.message?.content || "{}";
    let parsedContent = {};
    try {
      parsedContent = JSON.parse(content);
    } catch {
      const match = String(content).match(/\{[\s\S]*\}/);
      if (match) parsedContent = JSON.parse(match[0]);
    }

    const questions = (parsedContent.questions || []).filter((q) => q && q.question_text && q.correct_answer);
    if (questions.length === 0) {
      return res.status(200).json({ inserted: 0, message: "No questions generated" });
    }

    // Best-effort subtopic mapping by title similarity.
    let subtopicId = null;
    const { rows: subs } = await query(
      "SELECT id, title FROM public.subtopics WHERE topic_id = $1",
      [input.topic_id],
    );
    if (subs.length) {
      const st = input.section_title.toLowerCase();
      const match = subs.find((s) => s.title && (s.title.toLowerCase().includes(st) || st.includes(s.title.toLowerCase())));
      subtopicId = match?.id || null;
    }

    const rows = questions.map((q) => ({
      topic_id: input.topic_id,
      chapter_id: input.chapter_id,
      subtopic_id: subtopicId,
      question_text: q.question_text,
      question_type: q.question_type === "mcq" ? "mcq" : "short_answer",
      question_format: q.question_type === "mcq" ? "objective" : "subjective",
      options:
        q.question_type === "mcq" && Array.isArray(q.options)
          ? JSON.stringify(Object.fromEntries(q.options.map((opt, i) => [String.fromCharCode(65 + i), String(opt)])))
          : null,
      correct_answer: q.correct_answer,
      explanation: q.explanation ?? null,
      difficulty: q.difficulty ?? "medium",
      marks: 1,
      is_ai_generated: true,
      is_verified: false,
      source_document_purpose: "ai_notes",
      answer_source: "ai_notes",
    }));

    const columns = [
      "topic_id", "chapter_id", "subtopic_id", "question_text", "question_type", "question_format",
      "options", "correct_answer", "explanation", "difficulty", "marks", "is_ai_generated",
      "is_verified", "source_document_purpose", "answer_source",
    ];
    const ins = buildInsert("questions", columns, rows);
    let inserted;
    try {
      ({ rows: inserted } = await query(ins.text, ins.params));
    } catch (insErr) {
      return res.status(500).json({ error: "DB insert failed", details: insErr.message });
    }

    res.status(200).json({ inserted: inserted.length });
  } catch (err) {
    console.error("[generate-topic-notes-questions] error", err?.message);
    res.status(500).json({ error: String(err?.message || err) });
  }
});
