// Port of supabase/functions/extract-dpp-questions. Admin-only. Runs the whole DPP extraction for one
// dpp_documents row: parses the question/solution PDFs with Datalab when no markdown is given, deletes
// the document's earlier questions, then extracts and inserts MCQs chunk by chunk with the AI.
// POST { documentId, action, parsedContent: { questionsMmd, solutionsMmd } }.
//
// Config from env: DATALAB_API_KEY (required when a PDF must be parsed), DATALAB_API_BASE
// (default https://www.datalab.to). The AI endpoint comes from ai_settings, as in the other extract-* ports.
import express from "express";
import { query } from "../_shared/db.js";
import { userIdFromBearer, isAdminUser } from "../_shared/cdn-presentation-refresh-start-helper.js";
import { hookedFetch, loadAiEndpoint, postChat, insertRows } from "../_shared/extract-dpp-helper.js";

export const router = express.Router();

const sendJson = (res, status, body) => res.status(status).type("application/json").send(JSON.stringify(body));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

router.post("/", async (req, res) => {
  const userId = userIdFromBearer(req);
  if (!userId) return sendJson(res, 401, { error: "Unauthorized" });
  if (!(await isAdminUser(userId))) return sendJson(res, 403, { error: "Forbidden" });

  const { documentId, parsedContent } = req.body || {};
  if (!documentId) return sendJson(res, 400, { error: "documentId is required" });

  try {
    let document;
    try {
      const { rows } = await query("SELECT * FROM public.dpp_documents WHERE id = $1", [documentId]);
      document = rows[0];
    } catch {
      document = undefined;
    }
    if (!document) return sendJson(res, 404, { error: "Document not found" });

    await query("UPDATE public.dpp_documents SET status = 'processing', error_message = NULL WHERE id = $1", [documentId]);
    console.log(`[DPP Extraction] Starting extraction for document ${documentId}`);

    // Markdown from the client wins. Otherwise use the stored markdown, or parse the PDF.
    let questionsMmd = parsedContent?.questionsMmd || document.questions_mmd;
    let solutionsMmd = parsedContent?.solutionsMmd || document.solutions_mmd;

    if (!questionsMmd && document.questions_file_url) {
      questionsMmd = await parsePdfWithDatalab(document.questions_file_url);
      await query("UPDATE public.dpp_documents SET questions_mmd = $1 WHERE id = $2", [questionsMmd, documentId]);
    }
    if (!solutionsMmd && document.solutions_file_url) {
      solutionsMmd = await parsePdfWithDatalab(document.solutions_file_url);
      await query("UPDATE public.dpp_documents SET solutions_mmd = $1 WHERE id = $2", [solutionsMmd, documentId]);
    }
    if (!questionsMmd) throw new Error("No questions content available for extraction");

    // A fresh re-run replaces the earlier questions.
    await query("DELETE FROM public.questions WHERE source_document_id = $1", [documentId]);

    const { questionsCount, previewQuestions } = await extractAndInsertQuestionsWithAI({
      documentId,
      subjectId: document.subject_id,
      chapterId: document.chapter_id,
      topicId: document.topic_id,
      questionsMmd,
      solutionsMmd: solutionsMmd || "",
    });

    await query(
      "UPDATE public.dpp_documents SET status = 'completed', questions_count = $1, error_message = NULL WHERE id = $2",
      [questionsCount, documentId]
    );
    console.log(`[DPP Extraction] Successfully extracted ${questionsCount} questions`);

    // Only a preview comes back, to keep the response small.
    return sendJson(res, 200, { success: true, questionsCount, questions: previewQuestions });
  } catch (error) {
    console.error("[DPP Extraction] Error:", error.message);
    const message = error instanceof Error ? error.message : "Extraction failed";
    try {
      await query("UPDATE public.dpp_documents SET status = 'failed', error_message = $1 WHERE id = $2", [
        message,
        documentId,
      ]);
    } catch (e) {
      console.error("[DPP Extraction] Failed to update error status:", e.message);
    }
    return sendJson(res, 500, { error: message });
  }
});

async function parsePdfWithDatalab(pdfUrl) {
  const apiKey = process.env.DATALAB_API_KEY;
  if (!apiKey) throw new Error("DATALAB_API_KEY is not configured");
  const base = (process.env.DATALAB_API_BASE || "https://www.datalab.to").replace(/\/$/, "");

  const formData = new FormData();
  formData.append("file_url", pdfUrl);
  formData.append("output_format", "markdown");
  formData.append("force_ocr", "false");
  formData.append("paginate_output", "true");

  const response = await hookedFetch(`${base}/api/v1/marker`, {
    method: "POST",
    headers: { "X-API-Key": apiKey },
    body: formData,
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Datalab API error: ${response.status} - ${errorBody.slice(0, 300)}`);
  }

  const result = await response.json();
  const requestId = result.request_id;
  let markdown = "";
  const maxAttempts = 120; // about 10 minutes at 5-second polls

  for (let attempts = 0; attempts < maxAttempts && !markdown; attempts++) {
    await delay(5000);
    const statusResponse = await hookedFetch(`${base}/api/v1/marker/${requestId}`, {
      headers: { "X-API-Key": apiKey },
    });
    const statusResult = await statusResponse.json();
    if (statusResult.status === "complete") {
      markdown = statusResult.markdown || "";
      break;
    } else if (statusResult.status === "failed") {
      throw new Error("PDF parsing failed: " + (statusResult.error || "Unknown error"));
    }
  }

  if (!markdown) throw new Error("PDF parsing timed out");
  return markdown;
}

async function extractAndInsertQuestionsWithAI({ documentId, chapterId, topicId, questionsMmd, solutionsMmd }) {
  const previewQuestions = [];
  const previewLimit = 20;
  const seenQuestionNumbers = new Set();

  const maxChunkChars = 32000;
  const totalApproxChunks = Math.max(1, Math.ceil(questionsMmd.length / maxChunkChars));
  console.log(`[DPP Extraction] Chunking questions markdown: ${questionsMmd.length} chars (~${totalApproxChunks} chunks)`);

  let totalInserted = 0;
  let chunkIndex = 0;

  for (const chunk of iterateTextChunks(questionsMmd, maxChunkChars)) {
    chunkIndex += 1;
    console.log(`[DPP Extraction] Processing chunk ${chunkIndex}/${totalApproxChunks} (len=${chunk.length})...`);

    const questions = await extractQuestionsFromChunk(chunk, solutionsMmd, chunkIndex - 1);

    // Validate, trim and de-duplicate across chunks.
    const cleaned = (questions || [])
      .filter((q) => q && typeof q.question_number === "number" && Array.isArray(q.options))
      .map((q) => ({
        ...q,
        question_text: typeof q.question_text === "string" ? q.question_text.slice(0, 5000) : "",
        options: (q.options || []).slice(0, 4).map((o) => ({
          id: String(o?.id ?? "").slice(0, 5),
          text: typeof o?.text === "string" ? o.text.slice(0, 1500) : "",
        })),
        correct_answer: String(q.correct_answer ?? "").slice(0, 5),
        difficulty: q.difficulty || "medium",
        explanation: typeof q.explanation === "string" ? q.explanation.slice(0, 6000) : null,
      }))
      .filter((q) => q.question_text && q.options.length === 4 && q.correct_answer);

    const unique = [];
    for (const q of cleaned) {
      if (seenQuestionNumbers.has(q.question_number)) continue;
      seenQuestionNumbers.add(q.question_number);
      unique.push(q);
      if (previewQuestions.length < previewLimit) previewQuestions.push(q);
    }

    if (unique.length === 0) {
      console.log(`[DPP Extraction] Chunk ${chunkIndex}: no valid unique questions`);
      continue;
    }

    const mapDifficulty = (aiDiff) => {
      const mapping = { easy: "Low", medium: "Medium", hard: "Advanced" };
      return mapping[aiDiff?.toLowerCase()] || "Medium";
    };

    const toInsert = unique.map((q) => {
      const optionsObj = {};
      for (const opt of q.options) {
        if (opt.id && opt.text) optionsObj[opt.id.toLowerCase()] = opt.text;
      }
      return {
        topic_id: topicId,
        chapter_id: chapterId,
        question_text: q.question_text,
        question_type: "mcq",
        question_format: "single_choice", // "objective" is not allowed by questions_question_format_check
        options: JSON.stringify(optionsObj),
        correct_answer: q.correct_answer,
        explanation: q.explanation || null,
        difficulty: mapDifficulty(q.difficulty),
        source_document_purpose: "dpp",
        source_document_id: documentId,
        is_ai_generated: true,
        is_verified: false,
      };
    });

    const columns = [
      "topic_id", "chapter_id", "question_text", "question_type", "question_format", "options",
      "correct_answer", "explanation", "difficulty", "source_document_purpose", "source_document_id",
      "is_ai_generated", "is_verified",
    ];
    for (let i = 0; i < toInsert.length; i += 50) {
      const batch = toInsert.slice(i, i + 50);
      try {
        await insertRows("questions", columns, batch);
      } catch (e) {
        console.error(`[DPP Extraction] Insert error (chunk ${chunkIndex}, batch ${i}):`, e.message);
        throw e;
      }
      totalInserted += batch.length;
    }

    await delay(200);
  }

  return { questionsCount: totalInserted, previewQuestions };
}

// Splits the markdown into chunks of at most maxChars, preferring to cut before a page marker or a question number.
function* iterateTextChunks(text, maxChars) {
  let start = 0;
  const boundaryRegex = /\n\[Page \d+\]|\n\d+\.\s+/g;

  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);

    if (end < text.length) {
      const lookback = Math.min(5000, end - start);
      const windowText = text.slice(end - lookback, end);
      boundaryRegex.lastIndex = 0;
      let lastMatchIndex = -1;
      let m = null;
      while ((m = boundaryRegex.exec(windowText))) {
        lastMatchIndex = m.index;
      }
      // Use the boundary only when it does not leave a tiny chunk.
      if (lastMatchIndex > 1000) {
        end = end - lookback + lastMatchIndex;
      }
    }

    if (end <= start) end = Math.min(start + maxChars, text.length);

    yield text.slice(start, end);
    start = end;
  }
}

const extractionTool = {
  type: "function",
  function: {
    name: "extract_mcq_questions",
    description: "Extract MCQ questions from educational document text",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              dpp_number: { type: "number", description: "DPP number if mentioned in header" },
              question_number: { type: "number", description: "Question number from document" },
              question_text: { type: "string", description: "Complete question with LaTeX math preserved" },
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "Option letter (a, b, c, d)" },
                    text: { type: "string", description: "Option text with LaTeX preserved" },
                  },
                  required: ["id", "text"],
                },
              },
              correct_answer: { type: "string", description: "Correct option letter (a, b, c, or d)" },
              explanation: { type: "string", description: "Explanation if available" },
              difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
            },
            required: ["question_number", "question_text", "options", "correct_answer", "difficulty"],
          },
        },
      },
      required: ["questions"],
    },
  },
};

async function extractQuestionsFromChunk(chunk, solutionsMmd, chunkIndex) {
  const endpoint = await loadAiEndpoint();
  if (!endpoint) {
    console.error("No valid AI API configuration found");
    throw new Error("AI API not configured. Please go to Admin → Settings → AI Functions API Key Settings to add your API key.");
  }

  const systemPrompt = `You are an expert at extracting MCQ questions from educational documents.

TASK: Extract ALL MCQ questions from the provided text chunk using the extract_mcq_questions function.

RULES:
1. Preserve ALL mathematical formulas as LaTeX ($...$ for inline, $$...$$ for display)
2. Include chemical formulas correctly
3. Do NOT skip any questions - extract every single MCQ
4. Each question MUST have exactly 4 options (a, b, c, d)
5. If answer key is visible, use it for correct_answer
6. Estimate difficulty: easy (basic), medium (application), hard (complex/multi-step)

ANSWER EXTRACTION:
- Look for answer patterns like "Ans: (b)", "Answer: B", "(b)", etc.
- If no answer visible, make best guess based on solutions if provided`;

  const userPrompt = `QUESTIONS CHUNK:
${chunk}

${solutionsMmd ? `SOLUTIONS (for answer reference):
${solutionsMmd.slice(0, 5000)}` : ""}

Extract ALL MCQ questions from the above text.`;

  const maxRetries = 2;
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      console.log(`[DPP Extraction] Retry attempt ${attempt} for chunk ${chunkIndex + 1}`);
      await delay(attempt * 1500);
    }

    try {
      const response = await postChat(endpoint, {
        model: endpoint.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        tools: [extractionTool],
        tool_choice: { type: "function", function: { name: "extract_mcq_questions" } },
        temperature: 0.1,
      });

      if (!response.ok) {
        const error = await response.text();
        console.error("[DPP Extraction] AI API error:", response.status, error.slice(0, 300));

        if (response.status === 429) {
          if (attempt < maxRetries) {
            lastError = new Error("Rate limit exceeded");
            continue;
          }
          throw new Error("Rate limit exceeded. Please try again later.");
        }
        if (response.status === 401 || response.status === 403) {
          throw new Error("Invalid or unauthorized API key. Please check your API key in Admin Settings.");
        }
        if (attempt < maxRetries) {
          lastError = new Error(`AI API error: ${response.status}`);
          continue;
        }
        throw new Error(`AI API error: ${response.status}`);
      }

      const result = await response.json();
      const message = result.choices?.[0]?.message;
      let parsed = null;

      // Structured output from tool_calls first.
      if (message?.tool_calls?.[0]?.function?.arguments) {
        try {
          parsed = JSON.parse(message.tool_calls[0].function.arguments);
          console.log(`[DPP Extraction] Chunk ${chunkIndex + 1}: Extracted ${parsed.questions?.length || 0} questions via tool_calls`);
        } catch (toolParseError) {
          console.error("[DPP Extraction] Failed to parse tool_calls:", toolParseError.message);
        }
      }

      // Fallback: JSON inside the message content.
      if (!parsed && message?.content) {
        try {
          let jsonText = message.content.trim();
          if (jsonText.startsWith("```")) {
            jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
          }
          const objectMatch = jsonText.match(/\{[\s\S]*\}/);
          const arrayMatch = jsonText.match(/\[[\s\S]*\]/);
          if (objectMatch) {
            parsed = JSON.parse(objectMatch[0]);
          } else if (arrayMatch) {
            parsed = { questions: JSON.parse(arrayMatch[0]) };
          }
          if (parsed) {
            console.log(`[DPP Extraction] Chunk ${chunkIndex + 1}: Extracted ${parsed.questions?.length || 0} questions via content fallback`);
          }
        } catch (contentParseError) {
          console.error("[DPP Extraction] Failed to parse content:", contentParseError.message);
        }
      }

      if (parsed?.questions && Array.isArray(parsed.questions)) return parsed.questions;

      console.warn(`[DPP Extraction] Chunk ${chunkIndex + 1}: No questions extracted`);
      return [];
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxRetries && !lastError.message.includes("API key")) continue;
      throw lastError;
    }
  }

  throw lastError || new Error("Extraction failed after retries");
}
