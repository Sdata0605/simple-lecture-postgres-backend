// Port of supabase/functions/ai-grade-assignment. Grades a batch of student answers with the admin AI
// provider and sanitises the marks (clamped to 0..max, one grade per question).
//
// POST /functions/v1/ai-grade-assignment
// body: { questions: [{ question_id, question, type, correct_answer, student_answer, marks }] }
import express from "express";
import { callAI, loadAiApiConfig, pickProvider } from "../_shared/ai-check-answer-helper.js";

export const router = express.Router();

const SYSTEM_PROMPT = `You are a strict but fair teacher grading student assignment answers.

For each question, you must:
1. Compare the student's answer with the expected answer
2. Award marks based on correctness:
   - Full marks for essentially correct answers
   - Partial marks for partially correct answers (award proportionally)
   - 0 marks for incorrect, irrelevant, or blank answers
3. Provide brief, constructive feedback (1-2 sentences)
4. Mark as correct only if the answer is substantially correct

Important:
- For MCQ/True-False: Only full marks (exact match) or 0 marks
- For short/long answers: Consider meaning, not exact wording
- Be strict but fair with partial marks
- Empty or "(No answer provided)" answers get 0 marks

Respond with a JSON array in this exact format:
[
  {
    "question_id": "q_0",
    "marks_awarded": 2,
    "feedback": "Correct explanation of the concept.",
    "is_correct": true
  }
]

Only output the JSON array, no additional text.`;

router.post("/", async (req, res) => {
  try {
    const questions = req.body?.questions;
    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: "No questions provided for grading" });
    }

    const provider = pickProvider(await loadAiApiConfig());
    if (!provider) {
      console.error("No valid AI API configuration found");
      return res
        .status(503)
        .json({ error: "AI API not configured. Please configure your API key in Admin Settings." });
    }

    const questionsText = questions
      .map(
        (q, i) => `
Question ${i + 1} (ID: ${q.question_id}, Type: ${q.type}, Max Marks: ${q.marks}):
${q.question}

Expected Answer: ${q.correct_answer}

Student's Answer: ${q.student_answer || "(No answer provided)"}
`
      )
      .join("\n---\n");

    console.log("Calling AI for grading...");

    const response = await callAI(
      provider.apiUrl,
      provider.apiKey,
      provider.model,
      SYSTEM_PROMPT,
      `Grade the following answers:\n\n${questionsText}`
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("AI API error:", response.status, errorText.slice(0, 200));
      if (response.status === 429) {
        return res.status(429).json({ error: "Rate limit exceeded. Please try again later." });
      }
      if (response.status === 401 || response.status === 403) {
        return res.status(response.status).json({
          error: "Invalid or unauthorized API key. Please check your API key in Admin Settings.",
        });
      }
      throw new Error(`AI API error: ${response.status}`);
    }

    const aiResponse = await response.json();
    const content = aiResponse.choices?.[0]?.message?.content || "";

    let gradedAnswers;
    try {
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error("No JSON array found in response");
      gradedAnswers = JSON.parse(jsonMatch[0]);
    } catch {
      console.error("Failed to parse AI response");
      gradedAnswers = questions.map((q) => ({
        question_id: q.question_id,
        marks_awarded: 0,
        feedback: "Unable to grade automatically. Please review manually.",
        is_correct: false,
      }));
    }

    const validatedGrades = questions.map((q) => {
      const graded = gradedAnswers.find((g) => g.question_id === q.question_id);
      if (!graded) {
        return { question_id: q.question_id, marks_awarded: 0, feedback: "Answer not graded.", is_correct: false };
      }
      const marksAwarded = Math.min(Math.max(0, graded.marks_awarded || 0), q.marks);
      return {
        question_id: q.question_id,
        marks_awarded: marksAwarded,
        feedback: graded.feedback || "",
        is_correct: graded.is_correct || marksAwarded === q.marks,
      };
    });

    const totalMarksAwarded = validatedGrades.reduce((sum, g) => sum + g.marks_awarded, 0);
    const totalMaxMarks = questions.reduce((sum, q) => sum + q.marks, 0);

    console.log(`Grading complete: ${totalMarksAwarded}/${totalMaxMarks}`);

    return res.json({
      grades: validatedGrades,
      total_marks_awarded: totalMarksAwarded,
      total_max_marks: totalMaxMarks,
      percentage: totalMaxMarks > 0 ? Math.round((totalMarksAwarded / totalMaxMarks) * 100) : 0,
    });
  } catch (error) {
    console.error("Grading error:", String(error?.message ?? error).slice(0, 200));
    return res.status(500).json({ error: error instanceof Error ? error.message : "Failed to grade assignment" });
  }
});

export default router;
