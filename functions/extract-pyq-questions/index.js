// Port of supabase/functions/extract-pyq-questions. Pulls the questions (no answers) out of a previous
// year paper. Long documents are split into overlapping chunks, the chunks are sent to the AI
// provider in parallel, and the results are merged and renumbered.
// Auth: a valid user Bearer token, or x-service-key matching SERVICE_KEY.
// Fix: the original's OpenRouter branch assigned undeclared variables and would have thrown. Here
// every provider branch returns its settings directly.
import express from "express";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { query } from "../_shared/db.js";

export const router = express.Router();

// Test hook: lets tests stub the AI provider and skip retry pauses.
export const hooks = {
  fetch: (...args) => fetch(...args),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const MAX_QUESTIONS = 300;
const CHUNK_SIZE = 100000;
const CHUNK_OVERLAP = 5000;

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

// Regex pre-scan to estimate the question count.
export function preScanDocument(text) {
  const patterns = [];
  let total = 0;
  const checks = [
    [/(?:^|\n)\s*\d{1,3}\s*[.)]\s+\S/g, 3, "numbered (1. or 1))"],
    [/(?:^|\n)\s*Q\.?\s*\d{1,3}/gi, 2, "Q-prefixed"],
    [/(?:^|\n)\s*\(\d{1,3}\)\s+\S/g, 3, "parenthesized"],
    [/(?:^|\n)\s*question\s*[\d:]/gi, 1, "'Question N' format"],
  ];
  for (const [re, min, label] of checks) {
    const found = text.match(re);
    if (found && found.length > min) {
      total = Math.max(total, found.length);
      patterns.push(`${found.length} ${label}`);
    }
  }
  return { estimatedCount: total || 20, patterns };
}

// Splits text into overlapping chunks at a newline when one is near the end. At most four chunks.
export function chunkDocument(text) {
  if (text.length <= CHUNK_SIZE) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_SIZE, text.length);
    if (end < text.length) {
      const lastNewline = text.lastIndexOf("\n", end);
      if (lastNewline > start + CHUNK_SIZE * 0.7) end = lastNewline;
    }
    chunks.push(text.slice(start, end));
    start = end - CHUNK_OVERLAP;
    if (start < 0) start = 0;
    if (chunks.length >= 4) break;
  }
  console.log(`[PYQ] Document chunked into ${chunks.length} parts (total ${text.length} chars)`);
  return chunks;
}

// Turns raw AI output into clean questions: numbered, de-duplicated, sorted.
export function normalizeQuestions(raw) {
  const seen = new Set();
  const result = [];
  for (const q of raw) {
    const num = Number(q.question_number || q.number || 0);
    if (num <= 0 || num > MAX_QUESTIONS || seen.has(num)) continue;
    seen.add(num);

    let format = "subjective";
    const qType = String(q.question_format || q.question_type || "").toLowerCase();
    if (qType === "mcq" || qType === "single_choice" || qType === "multiple_choice") format = "mcq";
    else if (qType === "true_false") format = "true_false";
    else if (q.options && typeof q.options === "object" && Object.keys(q.options).length >= 2) format = "mcq";

    let options = null;
    if (format === "mcq" && q.options) {
      options = {};
      if (Array.isArray(q.options)) {
        const labels = ["A", "B", "C", "D", "E"];
        q.options.forEach((opt, i) => {
          if (i < labels.length) options[labels[i]] = { text: typeof opt === "string" ? opt : opt?.text || String(opt) };
        });
      } else if (typeof q.options === "object") {
        for (const [key, val] of Object.entries(q.options)) {
          const normalKey = key.toUpperCase().replace(/[^A-E]/g, "");
          if (normalKey && normalKey.length === 1) {
            options[normalKey] = { text: typeof val === "string" ? val : val?.text || String(val) };
          }
        }
      }
    }

    let difficulty = "Medium";
    const rawDiff = String(q.difficulty || "medium").toLowerCase();
    if (rawDiff.includes("easy") || rawDiff.includes("low")) difficulty = "Low";
    else if (rawDiff.includes("hard") || rawDiff.includes("advanced")) difficulty = "Advanced";
    else if (rawDiff.includes("intermediate")) difficulty = "Intermediate";

    const questionText = String(q.question_text || q.text || q.question || "").trim();
    if (!questionText || questionText.length < 3) continue;

    result.push({
      question_number: num,
      question_text: questionText,
      question_format: format,
      options,
      marks: Number(q.marks || q.mark || 1),
      difficulty,
    });
  }
  return result.sort((a, b) => a.question_number - b.question_number);
}

// Finds the question list in an AI reply: tool-call arguments first, then JSON in the content.
export function parseAIResponse(message) {
  const toolArgs = message?.tool_calls?.[0]?.function?.arguments;
  if (toolArgs) {
    try {
      const parsed = typeof toolArgs === "string" ? JSON.parse(toolArgs) : toolArgs;
      const qs = parsed.questions || (Array.isArray(parsed) ? parsed : null);
      if (Array.isArray(qs) && qs.length > 0) return qs;
    } catch (e) {
      console.error("[PYQ] Failed to parse tool_calls arguments:", e?.message);
    }
  }

  const content = message?.content || "";
  if (content) {
    try {
      let jsonText = content.trim();
      if (jsonText.startsWith("```")) jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
      const objMatch = jsonText.match(/\{[\s\S]*"questions"\s*:\s*\[[\s\S]*\][\s\S]*\}/);
      if (objMatch) {
        const parsed = JSON.parse(objMatch[0]);
        if (Array.isArray(parsed.questions) && parsed.questions.length > 0) return parsed.questions;
      }
      const arrMatch = jsonText.match(/\[[\s\S]*\]/);
      if (arrMatch) {
        const parsed = JSON.parse(arrMatch[0]);
        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].question_text) return parsed;
      }
    } catch (e) {
      console.error("[PYQ] Failed to parse content as JSON:", e?.message);
    }
  }
  return null;
}

// Provider settings from ai_settings. Returns null when no provider is enabled with a key.
export async function getAIConfig() {
  const { rows } = await query(
    "SELECT setting_value FROM public.ai_settings WHERE setting_key = 'ai_api_config' LIMIT 1",
  );
  const config = rows[0]?.setting_value;
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
      model: config.default_model || "gpt-4o",
    };
  }
  return null;
}

const EXTRACT_TOOL = [
  {
    type: "function",
    function: {
      name: "extract_questions",
      description: "Extract all questions from a document (no answers)",
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                question_number: { type: "number" },
                question_text: { type: "string" },
                question_format: { type: "string", enum: ["mcq", "subjective", "true_false"] },
                options: {
                  type: "object",
                  description: "MCQ options. Null for non-MCQ.",
                  additionalProperties: { type: "string" },
                },
                marks: { type: "number" },
                difficulty: { type: "string", enum: ["Low", "Medium", "Intermediate", "Advanced"] },
              },
              required: ["question_number", "question_text", "question_format"],
            },
          },
        },
        required: ["questions"],
      },
    },
  },
];

// Sends one chunk to the AI provider, with up to two retries. Returns normalised questions.
async function extractFromChunk(aiConfig, chunkText, chunkIndex, totalChunks, estimatedCount, preScanPatterns) {
  const systemPrompt = `You are an expert document question extractor. Read the ENTIRE document content below thoroughly.

Your job:
1. Identify ALL questions in this document — MCQ, subjective, true/false, fill-in-blank, match-the-following, short answer, long answer, or any other type
2. Extract each question with its EXACT text as written in the document
3. Do NOT extract, generate, or include answers, solutions, answer keys, or explanations
4. Detect the question format automatically
5. Preserve ALL mathematical notation (LaTeX, KaTeX, formulas) exactly as written
6. Preserve image references (like ![image](...)) exactly

For each question return:
- question_number: sequential integer starting from 1
- question_text: the exact question text from the document
- question_format: "mcq" (has options A/B/C/D), "subjective" (written/short/long answer), or "true_false"
- options: for MCQ only, { "A": "option text", "B": "option text", ... }. null for non-MCQ
- marks: estimated marks (default 1)
- difficulty: "Low" | "Medium" | "Intermediate" | "Advanced"

CRITICAL: Extract EVERY question you find. Do not skip any. ${totalChunks > 1 ? `This is chunk ${chunkIndex + 1} of ${totalChunks}. Continue sequential numbering from where the previous chunk left off.` : ""}
Pre-scan found approximately ${estimatedCount} questions${preScanPatterns.length > 0 ? ` (formats: ${preScanPatterns.join(", ")})` : ""}.`;

  const userPrompt = `Extract ALL questions from this document content. Do NOT include answers or solutions.\n\nDocument content:\n${chunkText}`;

  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) await hooks.sleep(attempt * 2000);
      console.log(`[PYQ] Chunk ${chunkIndex + 1}/${totalChunks}, attempt ${attempt + 1}, text length: ${chunkText.length}`);

      const response = await hooks.fetch(aiConfig.apiUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${aiConfig.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: aiConfig.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          tools: EXTRACT_TOOL,
          tool_choice: { type: "function", function: { name: "extract_questions" } },
          temperature: 0.1 + attempt * 0.1,
          max_tokens: 64000,
        }),
        signal: AbortSignal.timeout(300_000),
      });

      if (response.status === 429) {
        console.warn(`[PYQ] Rate limited on attempt ${attempt + 1}`);
        if (attempt < maxRetries) continue;
        throw new Error("Rate limited");
      }
      if (!response.ok) {
        console.error(`[PYQ] API error ${response.status}`);
        if (attempt < maxRetries) continue;
        throw new Error(`API error ${response.status}`);
      }

      const data = await response.json();
      const message = data.choices?.[0]?.message;
      const rawQuestions = parseAIResponse(message);
      if (rawQuestions && rawQuestions.length > 0) {
        const normalized = normalizeQuestions(rawQuestions);
        console.log(`[PYQ] Chunk ${chunkIndex + 1}: extracted ${normalized.length} valid questions from ${rawQuestions.length} raw`);
        return normalized;
      }
      console.warn(`[PYQ] Chunk ${chunkIndex + 1}: no questions parsed on attempt ${attempt + 1}`);
      if (attempt < maxRetries) continue;
    } catch (err) {
      console.error(`[PYQ] Chunk ${chunkIndex + 1} attempt ${attempt + 1} failed:`, err?.message);
      if (attempt >= maxRetries) throw err;
    }
  }
  return [];
}

// Joins chunk results, dropping repeats (same first 80 characters), and renumbers.
export function mergeChunkResults(chunkResults) {
  const allQuestions = [];
  const seenTexts = new Set();
  for (const chunk of chunkResults) {
    for (const q of chunk) {
      const key = q.question_text.slice(0, 80).toLowerCase().replace(/\s+/g, " ");
      if (seenTexts.has(key)) continue;
      seenTexts.add(key);
      allQuestions.push(q);
    }
  }
  return allQuestions.map((q, i) => ({ ...q, question_number: i + 1 }));
}

router.post("/", async (req, res) => {
  try {
    if (!isAuthorised(req)) return res.status(401).json({ error: "Unauthorized" });
    const { contentJson, contentMarkdown, documentAnalysis } = req.body || {};

    let extractionText = "";
    if (contentMarkdown && typeof contentMarkdown === "string" && contentMarkdown.length > 100) {
      extractionText = contentMarkdown;
    } else if (contentJson) {
      extractionText = typeof contentJson === "string" ? contentJson : JSON.stringify(contentJson);
    }

    if (!extractionText || extractionText.length < 50) {
      return res.json({
        success: false,
        questions: [],
        questionsCount: 0,
        error: "No valid document content provided",
        errorCode: "NO_CONTENT",
      });
    }

    const { estimatedCount, patterns } = preScanDocument(extractionText);
    const analysisCount = documentAnalysis?.totalEstimatedQuestions;
    const finalEstimate = analysisCount || estimatedCount;

    const aiConfig = await getAIConfig();
    if (!aiConfig) {
      return res.json({
        success: false,
        questions: [],
        questionsCount: 0,
        error: "AI API not configured. Please configure Google or OpenAI API key in AI Settings.",
        errorCode: "AI_NOT_CONFIGURED",
      });
    }

    const chunks = chunkDocument(extractionText);
    const chunkResults = await Promise.all(
      chunks.map((chunk, i) => extractFromChunk(aiConfig, chunk, i, chunks.length, finalEstimate, patterns)),
    );
    const questions = chunks.length === 1 ? chunkResults[0] : mergeChunkResults(chunkResults);

    console.log(`[PYQ] Final result: ${questions.length} questions extracted from ${chunks.length} chunk(s)`);

    res.json({
      success: questions.length > 0,
      questions,
      questionsCount: questions.length,
      estimatedCount: finalEstimate,
      chunksProcessed: chunks.length,
      error:
        questions.length === 0
          ? "No questions could be extracted from this document. The AI could not identify question patterns."
          : undefined,
      errorCode: questions.length === 0 ? "NO_QUESTIONS" : undefined,
    });
  } catch (error) {
    console.error("[PYQ] Fatal extraction error:", error?.message);
    res.json({
      success: false,
      questions: [],
      questionsCount: 0,
      error: error?.message || "Extraction failed",
      errorCode: "EXTRACTION_ERROR",
    });
  }
});
