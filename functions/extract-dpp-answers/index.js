// Port of supabase/functions/extract-dpp-answers. Admin-only. Reads the answer key from a document's
// markdown (regex patterns first, then the AI when the regexes find fewer than half the answers) and
// writes correct_answer onto the document's questions that do not have one yet, in question order.
// POST { documentId, fullMmd }.
import express from "express";
import { query } from "../_shared/db.js";
import { userIdFromBearer, isAdminUser } from "../_shared/cdn-presentation-refresh-start-helper.js";
import { loadAiEndpoint, postChat } from "../_shared/extract-dpp-helper.js";

export const router = express.Router();

const sendJson = (res, status, body) => res.status(status).type("application/json").send(JSON.stringify(body));

router.post("/", async (req, res) => {
  const userId = userIdFromBearer(req);
  if (!userId) return sendJson(res, 401, { error: "Unauthorized" });
  if (!(await isAdminUser(userId))) return sendJson(res, 403, { error: "Forbidden" });

  try {
    const { documentId, fullMmd } = req.body || {};
    if (!documentId) return sendJson(res, 400, { error: "Missing required field: documentId" });

    console.log(`Extracting answers for document ${documentId}`);

    const { rows: questions } = await query(
      "SELECT id FROM public.questions WHERE source_document_id = $1 AND (correct_answer IS NULL OR correct_answer = '') ORDER BY id ASC",
      [documentId]
    );
    const totalQuestions = questions.length;

    const answerMap = await extractAnswerKey(String(fullMmd ?? ""), totalQuestions);

    let answersApplied = 0;
    const missingAnswers = [];
    for (let i = 0; i < questions.length; i++) {
      const questionNumber = i + 1;
      const answer = answerMap[questionNumber];
      if (answer) {
        try {
          await query("UPDATE public.questions SET correct_answer = $1 WHERE id = $2", [
            answer.toUpperCase(),
            questions[i].id,
          ]);
          answersApplied++;
        } catch (e) {
          console.error(`Error updating question ${questions[i].id}:`, e.message);
        }
      } else {
        missingAnswers.push(questionNumber);
      }
    }

    // The original marked any dpp_documents still in 'extracting_answers' as completed. Kept as is.
    await query(
      "UPDATE public.dpp_documents SET status = 'completed', questions_count = $1 WHERE status = 'extracting_answers'",
      [totalQuestions]
    );

    return sendJson(res, 200, {
      success: true,
      answersApplied,
      totalQuestions,
      missingAnswers: missingAnswers.length > 0 ? missingAnswers : undefined,
    });
  } catch (error) {
    console.error("Error extracting answers:", error.message);
    return sendJson(res, 500, { error: error instanceof Error ? error.message : "Failed to extract answers" });
  }
});

// Question number -> answer letter, from the regex patterns, then the AI for any shortfall.
async function extractAnswerKey(fullMmd, expectedCount) {
  const answerMap = {};

  // Pattern 1: a dedicated ANSWER KEY section with "1. A" or "1) A" lines.
  // The original ended the section with \z, which in JS is a literal "z". Here it is end of input.
  const answerKeySection = fullMmd.match(/(?:ANSWER\s*KEY|ANSWERS?)[\s\S]*?(?=\n\n|(?![\s\S]))/i);
  if (answerKeySection) {
    const keyPattern = /\b(\d+)\s*[.):\-]\s*([A-Da-d])\b/gi;
    let km;
    while ((km = keyPattern.exec(answerKeySection[0])) !== null) {
      const qNum = parseInt(km[1], 10);
      if (qNum <= 200) answerMap[qNum] = km[2].toUpperCase();
    }
  }

  // Pattern 2: solution lines such as "1. (a)" or "Sol. 1: (b)".
  for (const match of fullMmd.matchAll(/(?:Sol(?:ution)?\.?\s*)?(\d+)\s*[.):\-]\s*\(([A-Da-d])\)/gi)) {
    const qNum = parseInt(match[1], 10);
    if (qNum <= 200 && !answerMap[qNum]) answerMap[qNum] = match[2].toUpperCase();
  }

  // Pattern 3: table rows such as "| 1 | A |" or "| 1 | (a) |".
  const tablePattern = /\|\s*(\d+)\s*\|\s*\(?([A-Da-d])\)?\s*\|/gi;
  let tableMatch;
  while ((tableMatch = tablePattern.exec(fullMmd)) !== null) {
    const qNum = parseInt(tableMatch[1], 10);
    if (qNum <= 200 && !answerMap[qNum]) answerMap[qNum] = tableMatch[2].toUpperCase();
  }

  // Pattern 4: inline "Ans: (a)" lines, attached to the last numbered question line above them.
  let currentQuestion = 0;
  for (const line of fullMmd.split("\n")) {
    const qNumMatch = line.match(/^(\d+)\s*[.)]/);
    if (qNumMatch) currentQuestion = parseInt(qNumMatch[1], 10);
    const ansMatch = line.match(/(?:Ans(?:wer)?[:.\s]+)\(?([A-Da-d])\)?/i);
    if (ansMatch && currentQuestion > 0 && currentQuestion <= 200 && !answerMap[currentQuestion]) {
      answerMap[currentQuestion] = ansMatch[1].toUpperCase();
    }
  }

  // Pattern 5: compact lists such as "1(A) 2(B) 3(C)" inside an answer section.
  const compactSection = fullMmd.match(/(?:ANSWER|KEY|SOLUTION)[\s\S]{0,500}?(\d+\s*\([A-Da-d]\)[\s\S]*?)(?:\n\n|$)/i);
  if (compactSection) {
    const compactPattern = /(\d+)\s*\(([A-Da-d])\)/g;
    let cm;
    while ((cm = compactPattern.exec(compactSection[1])) !== null) {
      const qNum = parseInt(cm[1], 10);
      if (qNum <= 200 && !answerMap[qNum]) answerMap[qNum] = cm[2].toUpperCase();
    }
  }

  if (Object.keys(answerMap).length >= expectedCount * 0.5) return answerMap;

  // Not enough from the regexes: ask the AI. Its answers only fill the gaps.
  const aiAnswers = await extractAnswersWithAI(fullMmd, expectedCount);
  for (const [qNum, answer] of Object.entries(aiAnswers)) {
    if (!answerMap[parseInt(qNum, 10)]) answerMap[parseInt(qNum, 10)] = answer;
  }
  return answerMap;
}

async function extractAnswersWithAI(content, expectedCount) {
  let endpoint;
  try {
    endpoint = await loadAiEndpoint();
  } catch {
    return {};
  }
  if (!endpoint) {
    console.error("No valid AI API configuration found");
    return {};
  }

  // Only the end of the document, where answer keys usually are.
  const truncatedContent = content.length > 15000 ? content.slice(-15000) : content;

  const systemPrompt = `You are an expert at extracting correct answers from educational documents.

The document may contain answers in various formats:
1. A dedicated "ANSWER KEY" section with format like "1. A, 2. B, 3. C"
2. A "SOLUTION" section where each question shows the correct answer as "(a)", "(b)", etc.
3. Inline answers where correct option is marked with "Ans:" or similar
4. Table format with question numbers and corresponding answers

Look for patterns like:
- "1. (a)" or "1. A" in answer sections
- "Ans: (a)" or "Answer: a"
- "Sol. 1: (b)" format
- Table rows with question number and answer letter

Extract the correct answer (A, B, C, or D) for each question number.
Only include answers you are confident about.`;

  const userPrompt = `Extract the answer key from this document. Expected around ${expectedCount} questions.
Return answers in format: question_number -> answer (A/B/C/D)

Document content:
${truncatedContent}`;

  const extractionTool = {
    type: "function",
    function: {
      name: "extract_answers",
      description: "Extract answer key mapping",
      parameters: {
        type: "object",
        properties: {
          answers: {
            type: "array",
            items: {
              type: "object",
              properties: {
                question_number: { type: "number" },
                correct_answer: { type: "string", enum: ["A", "B", "C", "D"] },
              },
              required: ["question_number", "correct_answer"],
            },
          },
        },
        required: ["answers"],
      },
    },
  };

  try {
    const response = await postChat(endpoint, {
      model: endpoint.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      tools: [extractionTool],
      tool_choice: { type: "function", function: { name: "extract_answers" } },
    });
    if (!response.ok) {
      console.error("AI API error:", response.status);
      return {};
    }

    const data = await response.json();
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
    if (toolCall?.function?.arguments) {
      const parsed = JSON.parse(toolCall.function.arguments);
      const result = {};
      for (const ans of parsed.answers || []) {
        result[ans.question_number] = ans.correct_answer;
      }
      return result;
    }
  } catch (error) {
    console.error("AI extraction error:", error.message);
  }
  return {};
}
