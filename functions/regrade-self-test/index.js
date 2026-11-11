// Port of supabase/functions/regrade-self-test.
// Re-scores a self test: MCQs are compared locally, written answers are read (OCR if only an image
// was uploaded) and graded by the ai-check-answer route. Only the student who owns the test, or an
// admin, may regrade it.
//
// Internal calls go to PUBLIC_BASE_URL with the caller's own Authorization header, as the original did.
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";

const BATCH = 3;

export const router = express.Router();

// Calls another function route with the caller's token. Returns { ok, status, data }.
async function invokeFn(name, body, authHeader) {
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  const res = await fetch(`${base}/functions/v1/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text) };
  } catch {
    return { ok: res.ok, status: res.status, data: { raw: text } };
  }
}

async function gradeWritten({ q, a }, authHeader) {
  const maxM = Number(q.marks ?? 1);
  let extracted = a.extracted_text || null;
  let studentAnswer = a.answer_text || "";

  if (!studentAnswer.trim() && a.answer_image_url) {
    if (!extracted) {
      const ocr = await invokeFn("extract-answer-from-image", {
        image_url: a.answer_image_url,
        question_context: q.question_text,
      }, authHeader);
      if (ocr.ok && ocr.data?.extracted_text && ocr.data.extracted_text !== "UNREADABLE") {
        extracted = ocr.data.extracted_text;
      }
    }
    studentAnswer = extracted || "[Image answer uploaded - could not extract]";
  }

  let isCorrect = false;
  let awarded = 0;
  let feedback = null;

  if (!q.correct_answer || !q.correct_answer.trim()) {
    feedback = "No reference answer available for grading.";
  } else if (!studentAnswer.trim()) {
    feedback = "No answer provided.";
  } else {
    const grade = await invokeFn("ai-check-answer", {
      question_id: q.id,
      question_text: q.question_text,
      question_type: "subjective",
      correct_answer: q.correct_answer,
      student_answer: studentAnswer,
      max_marks: maxM,
    }, authHeader);
    if (grade.ok) {
      isCorrect = !!grade.data.is_correct;
      awarded = Number(grade.data.marks_awarded) || 0;
      feedback = grade.data.feedback || null;
    } else {
      feedback = `AI grading failed (status ${grade.status}).`;
    }
  }

  await query(
    `UPDATE public.self_test_answers
        SET is_correct = $2, marks_awarded = $3, max_marks = $4, ai_feedback = $5, extracted_text = $6
      WHERE id = $1`,
    [a.id, isCorrect, awarded, maxM, feedback, extracted]
  );
  return awarded;
}

router.all("/", async (req, res) => {
  const json = (status, body) => res.status(status).json(body);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace("Bearer ", "");
    if (!token) return json(401, { error: "Unauthorized" });

    let userId;
    try {
      userId = jwt.verify(token, process.env.JWT_SECRET).sub;
    } catch {
      return json(401, { error: "Unauthorized" });
    }
    if (!userId) return json(401, { error: "Unauthorized" });

    const selfTestId = req.body?.self_test_id;
    if (!selfTestId) return json(400, { error: "self_test_id required" });

    const { rows: testRows } = await query("SELECT * FROM public.self_tests WHERE id = $1 LIMIT 1", [selfTestId]);
    const test = testRows[0];
    if (!test) return json(404, { error: "Test not found" });

    // Owner, or an admin.
    if (test.student_id !== userId) {
      const { rows: roleRows } = await query(
        "SELECT 1 FROM public.user_roles WHERE user_id = $1 AND role = 'admin' LIMIT 1",
        [userId]
      );
      if (roleRows.length === 0) return json(403, { error: "Forbidden" });
    }

    const { rows: questions } = await query(
      "SELECT * FROM public.self_test_questions WHERE self_test_id = $1",
      [selfTestId]
    );
    const { rows: answers } = await query("SELECT * FROM public.self_test_answers WHERE self_test_id = $1", [selfTestId]);

    const ansBy = {};
    for (const a of answers) ansBy[a.self_test_question_id] = a;

    let mcqScore = 0;
    let writtenScore = 0;
    let totalMax = 0;
    const mcqUpdates = [];
    const writtenTasks = [];

    for (const q of questions) {
      const a = ansBy[q.id];
      const maxM = Number(q.marks ?? 1);
      totalMax += maxM;
      if (!a) continue;

      if (q.section === "mcq") {
        const sel = (a.selected_option || a.answer_text || "").trim().toLowerCase();
        const correct = (q.correct_answer || "").trim().toLowerCase();
        const isCorrect = sel.length > 0 && sel === correct;
        const awarded = isCorrect ? maxM : 0;
        mcqScore += awarded;
        mcqUpdates.push({ id: a.id, is_correct: isCorrect, marks_awarded: awarded, max_marks: maxM });
      } else {
        writtenTasks.push({ q, a });
      }
    }

    for (const u of mcqUpdates) {
      await query(
        "UPDATE public.self_test_answers SET is_correct = $2, marks_awarded = $3, max_marks = $4 WHERE id = $1",
        [u.id, u.is_correct, u.marks_awarded, u.max_marks]
      );
    }

    // Written answers are graded in batches of three.
    for (let i = 0; i < writtenTasks.length; i += BATCH) {
      const slice = writtenTasks.slice(i, i + BATCH);
      const results = await Promise.all(slice.map((task) => gradeWritten(task, authHeader)));
      writtenScore += results.reduce((s, x) => s + x, 0);
    }

    const totalScore = mcqScore + writtenScore;
    const percentage = totalMax > 0 ? Math.round((totalScore / totalMax) * 1000) / 10 : 0;

    await query(
      `UPDATE public.self_tests
          SET mcq_score = $2, written_score = $3, total_score = $4, total_max_marks = $5, percentage = $6
        WHERE id = $1`,
      [selfTestId, mcqScore, writtenScore, totalScore, totalMax, percentage]
    );

    return json(200, {
      success: true,
      mcq_score: mcqScore,
      written_score: writtenScore,
      total_score: totalScore,
      total_max_marks: totalMax,
      percentage,
    });
  } catch (e) {
    console.error("[regrade-self-test]", e?.message);
    return json(500, { error: e instanceof Error ? e.message : "Unknown error" });
  }
});

export default router;
