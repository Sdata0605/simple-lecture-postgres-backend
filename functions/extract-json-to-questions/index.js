// Port of supabase/functions/extract-json-to-questions. Asks the configured AI provider to pull every
// question out of a document's content (markdown or JSON), normalises the result and inserts it
// into public.questions as AI-generated, unverified rows.
// Auth: a valid user Bearer token, or the x-service-key header matching SERVICE_KEY.
// Schema note: the original also wrote category_id, llm_verified and verification_status. Those
// columns are not in public.questions, so they are not written. chapter_id is written from the
// chapterId input, which the original accepted but did not store.
import express from "express";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { query } from "../_shared/db.js";

export const router = express.Router();

// Test hook: lets tests stub the AI provider so no real request is sent.
export const hooks = { fetch: (...args) => fetch(...args) };

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

// Same provider selection as the other AI functions.
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

const EXTRACTION_RULES = `You are an expert at extracting ALL types of questions from educational documents.

Analyze the following document content and extract EVERY question found. Questions may be:
- **MCQ (Multiple Choice)**: Has options A, B, C, D
- **True/False**: Answer is True or False
- **Short Answer**: Brief 1-3 sentence answer
- **Long Answer**: Detailed answer with explanations, proofs, derivations, chemical equations, diagrams

**CRITICAL RULES:**
1. Extract ALL question types, not just MCQs
2. **PRESERVE the answer EXACTLY as written in the document** - do NOT generate or modify answers
3. Preserve ALL image references exactly as they appear (e.g., ![alt](filename.jpg))
4. Preserve ALL LaTeX/math formulas exactly as written
5. Preserve chemical equations, circuit diagrams descriptions, and scientific notation

For each question, return:
{
  "question_text": "The complete question text with any image refs and formulas preserved",
  "question_type": "mcq" | "subjective" | "true_false",
  "question_format": "single_choice" | "subjective" | "true_false",
  "options": { "A": { "text": "Option A text" }, "B": { "text": "Option B text" }, "C": { "text": "..." }, "D": { "text": "..." } } // null for non-MCQ
  "correct_answer": "For MCQ: the correct option text. For subjective: the FULL answer as written in document. For T/F: True or False",
  "explanation": "Solution/explanation if present, null otherwise. Preserve image refs here too.",
  "difficulty": "Low" | "Medium" | "Advanced",
  "marks": 1 | 2 | 4 | 5 (based on complexity - MCQ=1, short=2, long=4-5),
  "contains_formula": true | false (true if question or answer contains LaTeX, chemical formulas, or math expressions)
}

IMPORTANT: Do NOT repeat image alt/description text after the image markdown reference. Keep only the ![alt](filename) syntax.

Return ONLY a valid JSON array of question objects. If no questions found, return [].

Document content:
`;

// Strips a markdown code fence from the model output, then parses it.
function parseModelJson(text) {
  let cleaned = String(text).trim();
  if (cleaned.startsWith("```json")) cleaned = cleaned.slice(7);
  else if (cleaned.startsWith("```")) cleaned = cleaned.slice(3);
  if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
  cleaned = cleaned.trim();
  let parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) parsed = parsed.questions || [parsed];
  return parsed;
}

function normaliseOptions(questionType, rawOptions) {
  if (questionType !== "mcq" || !rawOptions) return null;
  const options = {};
  if (typeof rawOptions === "object" && !Array.isArray(rawOptions)) {
    for (const [key, value] of Object.entries(rawOptions)) {
      const upperKey = key.toUpperCase();
      if (typeof value === "string") options[upperKey] = { text: value };
      else if (typeof value === "object" && value !== null && value.text) options[upperKey] = { text: value.text };
    }
  } else if (Array.isArray(rawOptions)) {
    const keys = ["A", "B", "C", "D", "E", "F"];
    rawOptions.forEach((opt, idx) => {
      if (idx < keys.length) options[keys[idx]] = { text: typeof opt === "string" ? opt : String(opt) };
    });
  }
  return options;
}

export function mapQuestion(q, { topicId, subtopicId, chapterId }) {
  const rawType = String(q.question_type || "").toLowerCase();
  let questionType = "mcq";
  let questionFormat = "single_choice";
  if (rawType === "subjective" || rawType === "short_answer" || rawType === "long_answer") {
    questionType = "subjective";
    questionFormat = "subjective";
  } else if (rawType === "true_false") {
    questionType = "true_false";
    questionFormat = "true_false";
  } else if (rawType === "mcq" || rawType === "single_choice" || rawType === "multiple_choice") {
    questionType = "mcq";
    questionFormat = q.question_format === "multiple_choice" ? "multiple_choice" : "single_choice";
  }

  const rawDiff = String(q.difficulty || "Medium").toLowerCase();
  let difficulty = "Medium";
  if (rawDiff === "easy" || rawDiff === "low") difficulty = "Low";
  else if (rawDiff === "medium") difficulty = "Medium";
  else if (rawDiff === "intermediate") difficulty = "Intermediate";
  else if (rawDiff === "hard" || rawDiff === "advanced") difficulty = "Advanced";

  const textToCheck = `${q.question_text || ""} ${q.correct_answer || ""} ${q.explanation || ""}`;
  const containsFormula =
    Boolean(q.contains_formula) ||
    textToCheck.includes("$") ||
    textToCheck.includes("\\(") ||
    textToCheck.includes("\\[") ||
    textToCheck.includes("\\frac") ||
    textToCheck.includes("\\sqrt");

  return {
    question_text: q.question_text || q.question || "",
    question_type: questionType,
    question_format: questionFormat,
    options: normaliseOptions(questionType, q.options),
    correct_answer: q.correct_answer || "",
    explanation: q.explanation || "",
    difficulty,
    marks: q.marks || (questionType === "subjective" ? 4 : 1),
    topic_id: topicId || null,
    subtopic_id: subtopicId || null,
    chapter_id: chapterId || null,
    contains_formula: containsFormula,
    is_verified: false,
    is_ai_generated: true,
  };
}

const INSERT_COLUMNS = [
  "question_text", "question_type", "question_format", "options", "correct_answer", "explanation",
  "difficulty", "marks", "topic_id", "subtopic_id", "chapter_id", "contains_formula", "is_verified",
  "is_ai_generated",
];

export function buildInsert(rows) {
  const params = [];
  const tuples = rows.map((row) => {
    const marks = INSERT_COLUMNS.map((c) => {
      params.push(row[c] === undefined ? null : row[c]);
      return `$${params.length}`;
    });
    return `(${marks.join(", ")})`;
  });
  return {
    text: `INSERT INTO public.questions (${INSERT_COLUMNS.join(", ")}) VALUES ${tuples.join(", ")} RETURNING id`,
    params,
  };
}

router.post("/", async (req, res) => {
  try {
    if (!isAuthorised(req)) return res.status(401).json({ error: "Unauthorized" });
    const { contentJson, subjectId, chapterId, topicId, subtopicId, entityType, entityName } = req.body || {};

    if (!contentJson || !subjectId || !chapterId) {
      return res.status(400).json({ error: "Missing required fields: contentJson, subjectId, chapterId" });
    }

    const { rows: cfgRows } = await query(
      "SELECT setting_value FROM public.ai_settings WHERE setting_key = 'ai_api_config' LIMIT 1",
    );
    const provider = pickProvider(cfgRows[0]?.setting_value);
    if (!provider) {
      return res.status(503).json({
        error: "AI API not configured. Please configure your API key in Admin Settings.",
        questionsCount: 0,
      });
    }

    const content =
      typeof contentJson === "string" ? contentJson : contentJson.content_markdown || JSON.stringify(contentJson, null, 2);

    console.log("Extracting questions from:", entityType, entityName);
    console.log("Content length:", content.length);

    const response = await hooks.fetch(provider.apiUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          {
            role: "system",
            content:
              "You are an expert at extracting structured question data from educational documents. Extract MCQs, short answer, and long answer questions. Preserve answers exactly as written. Always respond with valid JSON only.",
          },
          { role: "user", content: EXTRACTION_RULES + content.substring(0, 80000) },
        ],
        max_tokens: 16000,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(300_000),
    });

    if (!response.ok) {
      console.error("LLM API error:", response.status);
      throw new Error(`LLM API error: ${response.status}`);
    }

    const data = await response.json();
    const llmResponse = data.choices?.[0]?.message?.content || "[]";

    let extractedQuestions;
    try {
      extractedQuestions = parseModelJson(llmResponse);
    } catch (parseError) {
      console.error("Failed to parse LLM response:", parseError?.message);
      return res.status(200).json({
        error: "Failed to parse extracted questions",
        questionsCount: 0,
        details: "LLM response was not valid JSON",
      });
    }

    if (extractedQuestions.length === 0) {
      return res.json({ success: true, questionsCount: 0, message: "No questions found in the document" });
    }

    // The subject's category is no longer stored on questions, so only the ids the caller gave are used.
    const mapped = extractedQuestions.map((q) => mapQuestion(q, { topicId, subtopicId, chapterId }));
    const validQuestions = mapped.filter((q) => q.question_text.trim().length > 0);

    if (validQuestions.length === 0) {
      return res.json({ success: true, questionsCount: 0, message: "No valid questions found after parsing" });
    }

    const ins = buildInsert(validQuestions);
    const { rows: inserted } = await query(ins.text, ins.params);

    const typeCounts = validQuestions.reduce((acc, q) => {
      acc[q.question_type] = (acc[q.question_type] || 0) + 1;
      return acc;
    }, {});

    res.json({
      success: true,
      questionsCount: inserted.length,
      message: `Extracted ${inserted.length} questions (${Object.entries(typeCounts).map(([t, c]) => `${c} ${t}`).join(", ")})`,
      typeCounts,
    });
  } catch (error) {
    console.error("Error in extract-json-to-questions:", error?.message);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
      questionsCount: 0,
    });
  }
});
