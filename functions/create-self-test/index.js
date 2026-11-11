// Port of supabase/functions/create-self-test. The signed-in student gets a self test built from the
// questions of the chosen topics or chapters (about 70% MCQ, at most 30 questions). The test, its
// question snapshot and a timetable session are written. Called by the student's own token, and
// also by check-chapter-completion with that same token.
import express from "express";
import { query } from "../_shared/db.js";
import { userIdFromBearer } from "../_shared/cdn-presentation-refresh-start-helper.js";
import { insertRows } from "../_shared/extract-dpp-helper.js";

export const router = express.Router();

const MAX_QUESTIONS = 30;

const sendJson = (res, status, body) => res.status(status).type("application/json").send(JSON.stringify(body));

function isMcq(q) {
  const fmt = String(q.question_format || q.question_type || "").toLowerCase();
  if (fmt === "mcq" || fmt === "multiple_choice" || fmt === "objective") return true;
  if (q.options && typeof q.options === "object" && Object.keys(q.options).length >= 2) return true;
  return false;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const asArray = (v) => (Array.isArray(v) ? v : []);

router.post("/", async (req, res) => {
  const userId = userIdFromBearer(req);
  if (!userId) return sendJson(res, 401, { error: "Not authenticated" });

  try {
    const body = req.body || {};
    const { courseId, subjectId, testType, title, scheduledAt, durationMinutes } = body;
    const chapterIds = asArray(body.chapterIds);
    const topicIds = asArray(body.topicIds);

    if (!courseId || !subjectId || !title || !scheduledAt || !durationMinutes) {
      return sendJson(res, 400, { error: "Missing fields" });
    }
    if (testType !== "topic" && testType !== "chapter") {
      return sendJson(res, 400, { error: "Invalid testType" });
    }
    if (testType === "topic" && topicIds.length === 0) {
      return sendJson(res, 400, { error: "Pick at least one topic" });
    }
    if (testType === "chapter" && chapterIds.length === 0) {
      return sendJson(res, 400, { error: "Pick at least one chapter" });
    }

    const scopeColumn = testType === "topic" ? "topic_id" : "chapter_id";
    const scopeIds = testType === "topic" ? topicIds : chapterIds;
    const { rows: allQs } = await query(
      `SELECT id, question_text, options, correct_answer, question_format, question_type, marks,
              chapter_id, topic_id, is_verified
         FROM public.questions
        WHERE ${scopeColumn} = ANY($1::uuid[])
        LIMIT 500`,
      [scopeIds]
    );

    if (allQs.length === 0) {
      return sendJson(res, 400, {
        error: "No questions found for the selected scope. Please choose a different topic/chapter.",
      });
    }

    // Prefer verified questions when there are enough of them.
    const verified = allQs.filter((q) => q.is_verified);
    const poolQs = verified.length >= 5 ? verified : allQs;

    const mcqs = shuffle(poolQs.filter(isMcq));
    const written = shuffle(poolQs.filter((q) => !isMcq(q)));

    const targetMcq = Math.min(mcqs.length, Math.max(5, Math.round(MAX_QUESTIONS * 0.7)));
    const targetWritten = Math.min(written.length, MAX_QUESTIONS - targetMcq);
    const picked = [
      ...mcqs.slice(0, targetMcq).map((q) => ({ ...q, _section: "mcq" })),
      ...written.slice(0, targetWritten).map((q) => ({ ...q, _section: "written" })),
    ].slice(0, MAX_QUESTIONS);

    if (picked.length === 0) {
      return sendJson(res, 400, { error: "No usable questions in this scope." });
    }

    const mcqCount = picked.filter((p) => p._section === "mcq").length;
    const writtenCount = picked.length - mcqCount;

    const { rows: testRows } = await query(
      `INSERT INTO public.self_tests
         (student_id, course_id, subject_id, test_type, chapter_ids, topic_ids, title, scheduled_at,
          duration_minutes, total_questions, mcq_count, written_count, status)
       VALUES ($1, $2, $3, $4, $5::uuid[], $6::uuid[], $7, $8, $9, $10, $11, $12, 'scheduled')
       RETURNING id`,
      [
        userId,
        courseId,
        subjectId,
        testType,
        chapterIds,
        topicIds,
        title,
        scheduledAt,
        durationMinutes,
        picked.length,
        mcqCount,
        writtenCount,
      ]
    );
    const testId = testRows[0].id;

    await insertRows(
      "self_test_questions",
      ["self_test_id", "question_id", "chapter_id", "topic_id", "order_number", "section", "question_text", "options", "correct_answer", "marks"],
      picked.map((q, i) => ({
        self_test_id: testId,
        question_id: q.id,
        chapter_id: q.chapter_id,
        topic_id: q.topic_id,
        order_number: i + 1,
        section: q._section,
        question_text: q.question_text,
        options: q.options == null ? null : JSON.stringify(q.options),
        correct_answer: q.correct_answer ?? null,
        marks: q.marks || 1,
      }))
    );

    // Find or create the student's manual timetable for this course.
    const { rows: existingTt } = await query(
      "SELECT id FROM public.study_timetables WHERE student_id = $1 AND course_id = $2 AND mode = 'manual' LIMIT 1",
      [userId, courseId]
    );
    let timetableId = existingTt[0]?.id;
    if (!timetableId) {
      const { rows: newTt } = await query(
        "INSERT INTO public.study_timetables (student_id, course_id, mode) VALUES ($1, $2, 'manual') RETURNING id",
        [userId, courseId]
      );
      timetableId = newTt[0].id;
    }

    try {
      await query(
        `INSERT INTO public.study_timetable_sessions
           (timetable_id, student_id, course_id, subject_id, chapter_id, title, scheduled_at,
            duration_minutes, session_type, self_test_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'test', $9)`,
        [timetableId, userId, courseId, subjectId, chapterIds[0] || null, title, scheduledAt, durationMinutes, testId]
      );
    } catch (e) {
      // The original ignored this insert's error too. The test itself was created.
      console.error("[create-self-test] session insert failed", e.message);
    }

    return sendJson(res, 200, { id: testId, totalQuestions: picked.length, mcqCount, writtenCount });
  } catch (e) {
    console.error("[create-self-test]", e.message);
    return sendJson(res, 500, { error: e.message });
  }
});
