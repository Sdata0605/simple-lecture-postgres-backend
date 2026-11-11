// Port of supabase/functions/extract-dpp-page. Admin-only. Extracts MCQs from one page of a DPP
// document with the AI, saves them to the question bank (tagged source_document_purpose 'dpp') and
// records the page progress on the dpp document.
// POST { sourceDocumentId | documentId, dppDocumentId, pageNumber, pageContent, subjectId, chapterId, topicId }.
import express from "express";
import { query } from "../_shared/db.js";
import { userIdFromBearer, isAdminUser } from "../_shared/cdn-presentation-refresh-start-helper.js";
import { loadAiEndpoint, postChat, insertRows } from "../_shared/extract-dpp-helper.js";

export const router = express.Router();

const sendJson = (res, status, body) => res.status(status).type("application/json").send(JSON.stringify(body));

router.post("/", async (req, res) => {
  const userId = userIdFromBearer(req);
  if (!userId) return sendJson(res, 401, { error: "Unauthorized" });
  if (!(await isAdminUser(userId))) return sendJson(res, 403, { error: "Forbidden" });

  try {
    const body = req.body || {};
    const { pageNumber, pageContent, chapterId, topicId } = body;
    // documentId is the legacy name for both ids.
    const sourceDocumentId = body.sourceDocumentId ?? body.documentId;
    const dppDocumentId = body.dppDocumentId ?? body.documentId;

    if (!pageNumber || !pageContent) {
      return sendJson(res, 400, { error: "Missing required fields: pageNumber, pageContent" });
    }
    if (!sourceDocumentId && !dppDocumentId) {
      return sendJson(res, 400, {
        error: "Missing required fields: provide sourceDocumentId and/or dppDocumentId (or legacy documentId)",
      });
    }

    const questions = await extractQuestionsFromPage(pageContent, pageNumber);

    if (questions.length > 0) {
      if (!sourceDocumentId) {
        return sendJson(res, 400, { error: "sourceDocumentId is required to insert into question bank" });
      }

      // Check the foreign key first, so a bad id gives a 400 and not a cryptic 500.
      const { rows: sourceRows } = await query("SELECT id FROM public.uploaded_question_documents WHERE id = $1", [
        sourceDocumentId,
      ]);
      if (sourceRows.length === 0) {
        return sendJson(res, 400, {
          error: "Invalid sourceDocumentId (must reference uploaded_question_documents.id)",
          details: `Key (source_document_id)=(${sourceDocumentId}) is not present in uploaded_question_documents`,
        });
      }

      const toInsert = questions.map((q) => {
        // Options as an array of {id, text} become an object { a: 'text', ... }.
        const optionsObj = {};
        if (Array.isArray(q.options)) {
          q.options.forEach((opt) => {
            if (opt.id && opt.text) optionsObj[String(opt.id).toLowerCase()] = opt.text;
          });
        } else if (q.options && typeof q.options === "object") {
          Object.assign(optionsObj, q.options);
        }
        return {
          topic_id: topicId || null,
          chapter_id: chapterId || null,
          question_text: q.question_text,
          question_type: "mcq",
          question_format: "single_choice",
          options: JSON.stringify(optionsObj),
          correct_answer: "",
          difficulty: mapDifficultyToDb(q.difficulty),
          explanation: q.explanation || null,
          source_document_purpose: "dpp",
          source_document_id: sourceDocumentId,
          is_ai_generated: true,
          is_verified: false,
        };
      });

      try {
        await insertRows(
          "questions",
          [
            "topic_id", "chapter_id", "question_text", "question_type", "question_format", "options",
            "correct_answer", "difficulty", "explanation", "source_document_purpose", "source_document_id",
            "is_ai_generated", "is_verified",
          ],
          toInsert
        );
      } catch (e) {
        console.error("Error inserting questions:", e.message);
        throw new Error(`Failed to insert questions: ${e.message}`);
      }
    }

    if (dppDocumentId) {
      try {
        await query("UPDATE public.dpp_documents SET current_page = $1 WHERE id = $2", [pageNumber, dppDocumentId]);
      } catch (e) {
        console.error("Error updating document progress:", e.message);
      }
    }

    return sendJson(res, 200, {
      success: true,
      pageNumber,
      questionsFound: questions.length,
      sourceDocumentId,
      dppDocumentId,
    });
  } catch (error) {
    console.error("Error processing page:", error.message);
    return sendJson(res, 500, { error: error instanceof Error ? error.message : "Failed to process page" });
  }
});

async function extractQuestionsFromPage(pageContent, pageNumber) {
  const endpoint = await loadAiEndpoint();
  if (!endpoint) {
    throw new Error("AI API not configured. Please configure your API key in Admin Settings.");
  }

  const systemPrompt = `You are an expert at extracting MCQ questions from educational documents.
Extract all multiple choice questions from this page content.

IMPORTANT - Option Format Recognition:
The document uses markdown bullet format for options like:
- (a) Option text
- (b) Option text
OR numbered format like:
(a) Option text
(b) Option text
OR simple format like:
a) Option text
b) Option text

Rules:
1. Extract question_number, question_text, and ALL options (a, b, c, d)
2. Options are often formatted as "- (a) text" or "(a) text" - extract the text AFTER the letter identifier
3. DO NOT include the "(a)" or "a)" prefix in the option text - just the actual answer text
4. DO NOT include correct_answer - answers will be extracted separately
5. Set difficulty to "easy", "medium", or "hard" based on complexity
6. Preserve all mathematical notation (LaTeX/KaTeX format)
7. If options appear to be empty or just contain letters/numbers, SKIP that question
8. Include explanation if available in the content

Example Input:
1. The solubility of a gas in water depends on
- (a) Nature of the gas
- (b) Temperature
- (c) Pressure of the gas
- (d) All of the above

Expected Output:
{
  "question_number": 1,
  "question_text": "The solubility of a gas in water depends on",
  "options": {
    "a": "Nature of the gas",
    "b": "Temperature",
    "c": "Pressure of the gas",
    "d": "All of the above"
  }
}`;

  const userPrompt = `Extract all MCQ questions from this page content (Page ${pageNumber}):

${pageContent}`;

  const extractionTool = {
    type: "function",
    function: {
      name: "extract_questions",
      description: "Extract MCQ questions from the page",
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                question_number: { type: "number", description: "Question number" },
                question_text: { type: "string", description: "Full question text with all mathematical notation preserved" },
                options: {
                  type: "object",
                  properties: {
                    a: { type: "string", description: "Option A text (without the 'a)' prefix)" },
                    b: { type: "string", description: "Option B text (without the 'b)' prefix)" },
                    c: { type: "string", description: "Option C text (without the 'c)' prefix)" },
                    d: { type: "string", description: "Option D text (without the 'd)' prefix)" },
                  },
                  required: ["a", "b", "c", "d"],
                },
                difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
                explanation: { type: "string", description: "Explanation if available" },
              },
              required: ["question_number", "question_text", "options"],
            },
          },
        },
        required: ["questions"],
      },
    },
  };

  const response = await postChat(endpoint, {
    model: endpoint.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    tools: [extractionTool],
    tool_choice: { type: "function", function: { name: "extract_questions" } },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("AI API error:", response.status, errorText.slice(0, 300));
    throw new Error(`AI API error: ${response.status}`);
  }

  const data = await response.json();
  const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall?.function?.arguments) return [];

  try {
    const parsed = JSON.parse(toolCall.function.arguments);
    const questions = parsed.questions || [];
    return questions.filter((q) => {
      if (!q.options || typeof q.options !== "object") return false;
      const validOptionCount = Object.values(q.options).filter(
        (text) => typeof text === "string" && text.trim().length > 1
      ).length;
      if (validOptionCount < 2) return false;
      const badPatterns = ["i am sorry", "cannot locate", "not present in the document", "no questions"];
      const questionText = String(q.question_text || "").toLowerCase();
      return !badPatterns.some((p) => questionText.includes(p));
    });
  } catch (e) {
    console.error("Error parsing tool response:", e.message);
    return [];
  }
}

function mapDifficultyToDb(value) {
  const v = String(value ?? "").trim();
  if (v === "Low" || v === "Medium" || v === "Intermediate" || v === "Advanced") return v;
  const lc = v.toLowerCase();
  if (lc === "low") return "Low";
  if (lc === "medium") return "Medium";
  if (lc === "intermediate") return "Intermediate";
  if (lc === "advanced") return "Advanced";
  if (lc === "easy") return "Low";
  if (lc === "hard") return "Advanced";
  return "Medium";
}
