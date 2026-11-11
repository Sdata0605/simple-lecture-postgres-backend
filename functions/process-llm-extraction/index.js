// Port of supabase/functions/process-llm-extraction.
// Sends a processed document (MMD + JSON) to the configured AI provider, parses the questions
// it returns, and saves them to parsed_questions_pending and (for immediate student access) to questions.
//
// The provider is read from public.ai_settings ('ai_api_config'). Provider endpoints default to the
// public APIs and can be overridden with AI_OPENROUTER_URL, AI_GOOGLE_URL, AI_OPENAI_URL.
//
// Note: the original had no caller check. It is kept that way (see report); it is internal in use.
import express from "express";
import { query } from "../_shared/db.js";

const DEFAULT_URLS = {
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  google: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  openai: "https://api.openai.com/v1/chat/completions",
};

const SYSTEM_PROMPT = `You are an expert at parsing educational questions from JEE/NEET examination papers processed by Mathpix OCR.

**Input Format:**
1. Mathpix Markdown (MMD) - preserves LaTeX formulas and structure
2. Mathpix JSON - contains structured elements

**Your Task:**
Extract each question as a separate object with:
- question_text: Full question with LaTeX formulas preserved (e.g., \\( x^2 + 5x + 6 = 0 \\))
- question_format: "single_choice" (for MCQs), "multiple_choice", "true_false", "fill_blank", "short_answer"
- options: { "A": "...", "B": "...", "C": "...", "D": "..." } for MCQs (use null if not MCQ)
- correct_answer: The correct option letter(s) or answer text
- explanation: Solution/explanation if present (use null if not available)
- difficulty: Auto-detect based on complexity:
  * "Low" - Basic recall, simple arithmetic, direct formulas
  * "Medium" - Single-concept application, straightforward problem-solving
  * "Intermediate" - Multi-step reasoning, 2-3 concepts combined
  * "Advanced" - Complex analysis, advanced concepts, multi-layered reasoning
- difficulty_reasoning: Brief explanation (1 sentence) why you chose this difficulty

**Question Boundary Detection:**
- Look for question numbers: "Q1", "Q2", "1.", "2.", etc.
- Each MCQ typically has 4 options (A, B, C, D or 1, 2, 3, 4)
- Questions may span multiple lines
- Options may contain LaTeX formulas

**LaTeX Preservation:**
- Keep all LaTeX exactly as written: \\( ... \\) for inline, \\[ ... \\] for display
- Common symbols: \\sqrt{}, \\frac{}{}, \\int, \\sum, \\alpha, \\beta, etc.
- DO NOT modify or "fix" LaTeX unless it's clearly broken

**OCR Quality Assessment:**
Flag potential issues:
- Malformed LaTeX (unmatched braces, broken syntax)
- Garbled text or unclear question structure
- Missing options or incomplete data
- Unusual formatting

**Output Format:**
Return a valid JSON object with this structure:
{
  "questions": [
    {
      "question_text": "...",
      "question_format": "single_choice",
      "options": { "A": "...", "B": "...", "C": "...", "D": "..." },
      "correct_answer": "C",
      "explanation": "..." or null,
      "difficulty": "Medium",
      "difficulty_reasoning": "Requires understanding of quadratic formula application",
      "ocr_quality_notes": "Clean extraction" or "Minor LaTeX formatting issues detected"
    }
  ]
}

IMPORTANT: Return ONLY valid JSON. No markdown code blocks, no explanations, just the JSON object.`;

export const router = express.Router();

async function logJob(jobId, level, message, details) {
  await query(
    "INSERT INTO public.job_logs (job_id, log_level, message, details) VALUES ($1, $2, $3, $4::jsonb)",
    [jobId, level, message, details ? JSON.stringify(details) : null]
  );
}

async function updateJob(jobId, fields) {
  const cols = Object.keys(fields);
  const sets = cols.map((c, i) => `${c} = $${i + 2}${c === "result_data" ? "::jsonb" : ""}`);
  const values = cols.map((c) => (c === "result_data" ? JSON.stringify(fields[c]) : fields[c]));
  await query(
    `UPDATE public.document_processing_jobs SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`,
    [jobId, ...values]
  );
}

// Multi-row insert. Object and array values are stored as JSON.
async function insertRows(table, rows) {
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0]);
  const params = [];
  const tuples = rows.map((row) => {
    const ph = cols.map((c) => {
      const v = row[c];
      params.push(v !== null && typeof v === "object" ? JSON.stringify(v) : v === undefined ? null : v);
      const jsonish = v !== null && typeof v === "object";
      return `$${params.length}${jsonish ? "::jsonb" : ""}`;
    });
    return `(${ph.join(", ")})`;
  });
  await query(`INSERT INTO public.${table} (${cols.join(", ")}) VALUES ${tuples.join(", ")}`, params);
}

// Resolves the provider from settings. Returns { apiUrl, apiKey, model } or throws.
function resolveProvider(config) {
  const urls = {
    openrouter: process.env.AI_OPENROUTER_URL || DEFAULT_URLS.openrouter,
    google: process.env.AI_GOOGLE_URL || DEFAULT_URLS.google,
    openai: process.env.AI_OPENAI_URL || DEFAULT_URLS.openai,
  };
  if (config?.enabled && config?.provider === "openrouter" && config?.openrouter_api_key) {
    return { apiUrl: urls.openrouter, apiKey: config.openrouter_api_key, model: config.default_model || "google/gemini-2.5-flash" };
  }
  if (config?.enabled && config?.provider === "google" && config?.google_api_key) {
    return { apiUrl: urls.google, apiKey: config.google_api_key, model: config.default_model || "gemini-2.5-flash" };
  }
  if (config?.enabled && config?.provider === "openai" && config?.openai_api_key) {
    return { apiUrl: urls.openai, apiKey: config.openai_api_key, model: config.default_model || "gpt-4o-mini" };
  }
  console.error("No valid AI API configuration found");
  throw new Error("AI API not configured. Please go to Admin → Settings → AI Functions API Key Settings to add your API key.");
}

const containsFormula = (text) => (text || "").includes("\\(") || (text || "").includes("\\[");

async function extract(jobId, documentId) {
  await logJob(jobId, "info", "Starting LLM question extraction");

  const { rows: docRows } = await query("SELECT * FROM public.uploaded_question_documents WHERE id = $1", [documentId]);
  const document = docRows[0];
  if (!document) throw new Error("JSON object requested, multiple (or no) rows returned");

  // Use MMD if available (better LaTeX preservation), fall back to markdown.
  const documentContent = document.mathpix_mmd || document.mathpix_markdown;
  const documentJson = document.mathpix_json_output;
  if (!documentContent) throw new Error("Document has no processed content. Please process document first.");

  await logJob(jobId, "info", "Fetched document content", {
    has_mmd: !!document.mathpix_mmd,
    has_json: !!document.mathpix_json_output,
    content_length: documentContent?.length || 0,
  });
  await updateJob(jobId, { progress_percentage: 20, current_step: "Document fetched, preparing for extraction" });

  const { rows: cfgRows } = await query(
    "SELECT setting_value FROM public.ai_settings WHERE setting_key = 'ai_api_config' LIMIT 1"
  );
  const { apiUrl, apiKey, model } = resolveProvider(cfgRows[0]?.setting_value);

  const userPrompt = `Document: ${document.file_name}

**Mathpix Markdown (MMD):**
\`\`\`
${documentContent}
\`\`\`

${documentJson ? `**Mathpix JSON Structure:**
\`\`\`json
${JSON.stringify(documentJson, null, 2)}
\`\`\`
` : ""}

Extract all questions from this document. Return valid JSON only.`;

  await updateJob(jobId, { progress_percentage: 40, current_step: "Calling AI to extract questions" });
  await logJob(jobId, "info", "Invoking AI extraction", { prompt_length: userPrompt.length });

  const aiResponse = await fetch(apiUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
    }),
  });

  if (!aiResponse.ok) {
    const errorText = await aiResponse.text();
    await logJob(jobId, "error", "AI extraction failed", { status: aiResponse.status, error: errorText });
    if (aiResponse.status === 429) throw new Error("Rate limit exceeded. Please try again later.");
    if (aiResponse.status === 401 || aiResponse.status === 403) {
      throw new Error("Invalid or unauthorized API key. Please check your API key in Admin Settings.");
    }
    throw new Error(`AI API error: ${aiResponse.statusText}`);
  }

  const aiData = await aiResponse.json();
  const llmResponse = aiData.choices?.[0]?.message?.content;
  if (!llmResponse) throw new Error("No response from AI");

  await logJob(jobId, "info", "Received AI response", { response_length: llmResponse.length });
  await updateJob(jobId, { progress_percentage: 70, current_step: "Parsing AI response" });

  let extractedData;
  try {
    let jsonText = llmResponse.trim();
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```(?:json)?\n/, "").replace(/\n```$/, "");
    }
    extractedData = JSON.parse(jsonText);
  } catch (parseError) {
    await logJob(jobId, "error", "Failed to parse AI response", {
      error: parseError instanceof Error ? parseError.message : "Unknown error",
      response_preview: llmResponse.substring(0, 500),
    });
    throw new Error("Failed to parse AI response as JSON");
  }

  const questions = extractedData.questions || [];
  if (!Array.isArray(questions)) throw new Error("Invalid response format: questions is not an array");

  await logJob(jobId, "info", `Extracted ${questions.length} questions`);
  await updateJob(jobId, { progress_percentage: 80, current_step: `Saving ${questions.length} questions to database` });

  const difficultyDistribution = { Low: 0, Medium: 0, Intermediate: 0, Advanced: 0 };
  const pendingRows = questions.map((q) => {
    if (q.difficulty) difficultyDistribution[q.difficulty] = difficultyDistribution[q.difficulty] + 1;
    return {
      document_id: documentId,
      category_id: document.category_id,
      subject_id: document.subject_id,
      chapter_id: document.chapter_id,
      topic_id: document.topic_id,
      subtopic_id: document.subtopic_id,
      question_text: q.question_text,
      question_format: q.question_format || "single_choice",
      question_type: q.question_type || "objective",
      difficulty: q.difficulty || "Medium",
      marks: q.marks || 1,
      options: q.options || null,
      correct_answer: q.correct_answer,
      explanation: q.explanation || null,
      llm_suggested_difficulty: q.difficulty || "Medium",
      llm_difficulty_reasoning: q.difficulty_reasoning || null,
      contains_formula: containsFormula(q.question_text),
    };
  });

  try {
    await insertRows("parsed_questions_pending", pendingRows);
  } catch (insertError) {
    await logJob(jobId, "error", "Failed to insert questions", { error: insertError.message });
    throw insertError;
  }
  const insertedCount = pendingRows.length;

  // Also into the question bank, for immediate student access. A failure here is only a warning.
  // questions has CHECK constraints on question_type and question_format. The pending table does not,
  // so values the model invents (for example fill_blank) are mapped to the nearest allowed value here.
  const BANK_FORMATS = ["single_choice", "multiple_choice", "true_false", "subjective", "integer"];
  const bankRows = questions.map((q) => ({
    topic_id: document.topic_id,
    chapter_id: document.chapter_id,
    subtopic_id: document.subtopic_id,
    question_text: q.question_text,
    question_format: BANK_FORMATS.includes(q.question_format) ? q.question_format : q.options ? "single_choice" : "subjective",
    question_type: q.options ? "mcq" : "subjective",
    difficulty: q.difficulty || "Medium",
    marks: q.marks || 1,
    options: q.options || null,
    correct_answer: q.correct_answer,
    explanation: q.explanation || null,
    contains_formula: containsFormula(q.question_text),
    source_document_id: documentId,
    source_document_purpose: document.document_purpose || "general",
    is_ai_generated: true,
    is_verified: false,
  }));
  try {
    await insertRows("questions", bankRows);
    await logJob(jobId, "info", `Also inserted ${bankRows.length} questions into question bank for immediate student access`);
  } catch (qbErr) {
    // 'warning' is the level the job_logs check constraint allows.
    await logJob(jobId, "warning", "Failed to insert into questions table (students will see after approval)", { error: qbErr.message });
  }

  await updateJob(jobId, { progress_percentage: 95, current_step: "Finalizing extraction" });
  await query(
    `UPDATE public.document_processing_jobs
        SET status = 'completed', progress_percentage = 100, current_step = 'Extraction complete',
            completed_at = now(), questions_extracted = $2,
            result_data = $3::jsonb, updated_at = now()
      WHERE id = $1`,
    [jobId, insertedCount, JSON.stringify({ total_questions: insertedCount, difficulty_distribution: difficultyDistribution })]
  );
  await logJob(jobId, "info", `Extraction completed: ${insertedCount} questions saved`);
  console.log(`Question extraction completed: ${insertedCount} questions`);

  return { success: true, questionsExtracted: insertedCount, difficultyDistribution };
}

router.all("/", async (req, res) => {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let jobId = null;
  try {
    const body = req.body ?? {};
    jobId = body.jobId || null;
    const documentId = body.documentId || null;
    if (!jobId || !documentId) throw new Error("jobId and documentId are required");

    const result = await extract(jobId, documentId);
    return res.status(200).json(result);
  } catch (error) {
    console.error("Worker extraction error:", error?.message);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    if (jobId) {
      try {
        await query(
          `UPDATE public.document_processing_jobs
              SET status = 'failed', error_message = $2, error_details = $3::jsonb, completed_at = now()
            WHERE id = $1`,
          [jobId, errorMessage, JSON.stringify({
            stack: error instanceof Error ? error.stack : undefined,
            name: error instanceof Error ? error.name : "Error",
          })]
        );
        await logJob(jobId, "error", `Extraction failed: ${errorMessage}`, {
          error_type: error instanceof Error ? error.name : "Error",
          stack: error instanceof Error ? error.stack : undefined,
        });
      } catch (err) {
        console.error("Failed to record job failure:", err.message);
      }
    }
    return res.status(500).json({ error: errorMessage });
  }
});

export default router;
