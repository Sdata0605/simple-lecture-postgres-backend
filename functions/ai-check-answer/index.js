// Port of supabase/functions/ai-check-answer. Grades one student answer: exact match, MCQ letter,
// numeric, then an AI comparison (Lovable gateway first, then the admin-configured provider), and
// finally a word-overlap fallback. Public endpoint, same request and reply shapes as the original.
//
// POST /functions/v1/ai-check-answer
// body: { question_id, question_text, question_type, correct_answer, student_answer, max_marks? }
import express from "express";
import {
  callAI,
  calculateSimpleSimilarity,
  loadAiApiConfig,
  pickProvider,
} from "../_shared/ai-check-answer-helper.js";

export const router = express.Router();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SYSTEM_PROMPT = (maxMarks) => `You are an expert exam evaluator. Your task is to compare a student's answer with the correct answer and determine if they are semantically equivalent.

EVALUATION CRITERIA:
1. Semantic equivalence - Does the answer convey the same meaning? (not exact wording)
2. Mathematical equivalence - "2" = "2.0" = "two" = "II"
3. Scientific notation equivalence - "H2O" = "water" = "dihydrogen monoxide"
4. Consider alternative correct formulations
5. For partial answers, award partial credit proportionally

SCORING:
- Full marks: Answer is semantically correct (even if worded differently)
- Partial marks: Answer is partially correct or contains the key concept
- Zero marks: Answer is incorrect or unrelated

Respond ONLY with valid JSON in this exact format:
{
  "is_correct": boolean,
  "marks_awarded": number (0 to ${maxMarks}),
  "similarity_score": number (0 to 100),
  "feedback": "Brief explanation of the evaluation"
}`;

const userPromptFor = (q) => `Question: ${q.question_text}

Correct Answer: ${q.correct_answer}

Student's Answer: ${q.student_answer}

Maximum Marks: ${q.max_marks}

Evaluate the student's answer and provide your assessment.`;

router.post("/", async (req, res) => {
  try {
    const body = req.body ?? {};
    const question_id = body.question_id;
    const question_text = body.question_text;
    const question_type = body.question_type;
    const correct_answer = body.correct_answer;
    const student_answer = body.student_answer;
    const max_marks = body.max_marks === undefined ? 1 : body.max_marks;

    console.log(`[ai-check-answer] Checking answer for question ${question_id}`);
    console.log(`[ai-check-answer] Question type: ${question_type}`);

    // Placeholder from failed image extraction: skip AI grading.
    if (typeof student_answer === "string" && student_answer.startsWith("[Image answer uploaded")) {
      return res.json({
        is_correct: false,
        marks_awarded: 0,
        similarity_score: 0,
        feedback: "Image could not be read by AI. Please re-upload a clearer image or type your answer.",
      });
    }

    if (!student_answer || !String(student_answer).trim()) {
      return res.json({ is_correct: false, marks_awarded: 0, similarity_score: 0, feedback: "No answer provided." });
    }

    if (!correct_answer || !String(correct_answer).trim()) {
      return res.json({
        is_correct: false,
        marks_awarded: 0,
        similarity_score: 0,
        feedback: "Unable to evaluate - no correct answer available.",
      });
    }

    const normalizedStudent = String(student_answer).trim().toLowerCase();
    const normalizedCorrect = String(correct_answer).trim().toLowerCase();

    if (normalizedStudent === normalizedCorrect) {
      return res.json({ is_correct: true, marks_awarded: max_marks, similarity_score: 100, feedback: "Correct answer!" });
    }

    // MCQ single letters
    if (question_type === "mcq" || question_type === "single_choice") {
      const studentLetter = normalizedStudent.replace(/[^a-d]/gi, "").toLowerCase();
      const correctLetter = normalizedCorrect.replace(/[^a-d]/gi, "").toLowerCase();
      if (studentLetter.length === 1 && correctLetter.length === 1) {
        const isCorrect = studentLetter === correctLetter;
        return res.json({
          is_correct: isCorrect,
          marks_awarded: isCorrect ? max_marks : 0,
          similarity_score: isCorrect ? 100 : 0,
          feedback: isCorrect
            ? "Correct option selected!"
            : `Incorrect. The correct answer is ${String(correct_answer).toUpperCase()}.`,
        });
      }
    }

    // Integer / numerical questions
    if (question_type === "integer" || question_type === "numerical") {
      const studentNum = parseFloat(String(student_answer).replace(/[^\d.-]/g, ""));
      const correctNum = parseFloat(String(correct_answer).replace(/[^\d.-]/g, ""));
      if (!Number.isNaN(studentNum) && !Number.isNaN(correctNum)) {
        const isCorrect = Math.abs(studentNum - correctNum) < 0.001;
        return res.json({
          is_correct: isCorrect,
          marks_awarded: isCorrect ? max_marks : 0,
          similarity_score: isCorrect ? 100 : 0,
          feedback: isCorrect ? "Correct numerical answer!" : `Incorrect. The correct answer is ${correct_answer}.`,
        });
      }
    }

    const systemPrompt = SYSTEM_PROMPT(max_marks);
    const userPrompt = userPromptFor({ question_text, correct_answer, student_answer, max_marks });

    console.log("[ai-check-answer] Calling AI for semantic comparison");

    // Only the admin-configured AI provider (ai_settings 'ai_api_config') is used. No Lovable or other env keys.
    let response = null;
    {
      const config = await loadAiApiConfig();
      const provider = pickProvider(config);

      if (provider && config.provider === "openrouter") {
        response = await callAI(provider.apiUrl, provider.apiKey, provider.model, systemPrompt, userPrompt);
        if (!response.ok) {
          const errText = await response.text();
          console.error("[ai-check-answer] Admin OpenRouter error:", response.status, errText.slice(0, 200));
          response = null;
        }
      } else if (provider && config.provider === "google") {
        const FALLBACK_MODELS = ["gemini-2.5-flash-lite", "gemini-2.0-flash", "gemini-1.5-flash"];
        const primaryModel = provider.model;
        const googleApiUrl = provider.apiUrl;

        response = await callAI(googleApiUrl, provider.apiKey, primaryModel, systemPrompt, userPrompt);

        // Retry once on 503 / 429.
        if (response && (response.status === 503 || response.status === 429)) {
          const errText = await response.text();
          console.log("[ai-check-answer] Got", response.status, "- retrying after 2s...", errText.slice(0, 200));
          await sleep(2000);
          response = await callAI(googleApiUrl, provider.apiKey, primaryModel, systemPrompt, userPrompt);
        }

        // Fallback models if still failing.
        if (response && !response.ok) {
          const errText = await response.text();
          console.error("[ai-check-answer] Primary model failed:", response.status, errText.slice(0, 200));
          response = null;

          for (const fallbackModel of FALLBACK_MODELS) {
            const fbResponse = await callAI(googleApiUrl, provider.apiKey, fallbackModel, systemPrompt, userPrompt);
            if (fbResponse.ok) {
              response = fbResponse;
              console.log("[ai-check-answer] Fallback model succeeded:", fallbackModel);
              break;
            }
            const fbErr = await fbResponse.text();
            console.error("[ai-check-answer] Fallback", fallbackModel, "failed:", fbResponse.status, fbErr.slice(0, 200));
            await sleep(1000);
          }
        }
      } else if (provider && config.provider === "openai") {
        response = await callAI(provider.apiUrl, provider.apiKey, provider.model, systemPrompt, userPrompt);
        if (!response.ok) {
          const errText = await response.text();
          console.error("[ai-check-answer] Admin OpenAI API error:", response.status, errText.slice(0, 200));
          response = null;
        }
      }
    }

    // All AI calls failed: basic similarity.
    if (!response || !response.ok) {
      const similarity = calculateSimpleSimilarity(normalizedStudent, normalizedCorrect);
      const isCorrect = similarity >= 70;
      return res.json({
        is_correct: isCorrect,
        marks_awarded: isCorrect ? max_marks : Math.round((max_marks * similarity) / 100),
        similarity_score: similarity,
        feedback: isCorrect
          ? "Answer appears correct based on keyword matching."
          : `Answer partially matches (${similarity}% similarity). AI grading unavailable.`,
      });
    }

    const aiResponse = await response.json();
    const content = aiResponse.choices?.[0]?.message?.content;

    if (!content) {
      console.error("[ai-check-answer] No content in AI response");
      return res.json({ is_correct: false, marks_awarded: 0, similarity_score: 0, feedback: "Unable to evaluate answer." });
    }

    try {
      let jsonStr = content;
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
      } else {
        const objectMatch = content.match(/\{[\s\S]*\}/);
        if (objectMatch) jsonStr = objectMatch[0];
      }

      const result = JSON.parse(jsonStr);
      return res.json({
        is_correct: Boolean(result.is_correct),
        marks_awarded: Math.min(Math.max(0, Number(result.marks_awarded) || 0), max_marks),
        similarity_score: Math.min(Math.max(0, Number(result.similarity_score) || 0), 100),
        feedback: String(result.feedback || "Answer evaluated."),
      });
    } catch {
      console.error("[ai-check-answer] Failed to parse AI response");
      const lowerContent = content.toLowerCase();
      const isCorrect = lowerContent.includes("correct") && !lowerContent.includes("incorrect");
      return res.json({
        is_correct: isCorrect,
        marks_awarded: isCorrect ? max_marks : 0,
        similarity_score: isCorrect ? 80 : 20,
        feedback: "Answer evaluated.",
      });
    }
  } catch (error) {
    console.error("[ai-check-answer] Error:", String(error?.message ?? error).slice(0, 200));
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
      is_correct: false,
      marks_awarded: 0,
      similarity_score: 0,
      feedback: "Error evaluating answer.",
    });
  }
});

export default router;
