import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startServer, stopServer, base, q, makeUser } from "./helpers.js";

// Regression: MyTestTake's submit (src/hooks/useSelfTests.ts, useSubmitSelfTest) talks to the REST layer with
// supabase-js. It upserts one self_test_answers row per question (on_conflict=self_test_question_id,student_id,
// Prefer: resolution=merge-duplicates), then PATCHes self_tests with the score fields. This replays those exact
// requests as the student and checks the rows that land in the database.
describe("self test submit through /rest/v1", () => {
  let owner;
  let testId;
  let courseId;
  const questionIds = {};

  before(async () => {
    await startServer();
    owner = await makeUser();
    const [ref] = await q("SELECT s.id AS subject_id FROM public.popular_subjects s LIMIT 1");
    courseId = randomUUID();
    await q("INSERT INTO public.courses (id, name, slug) VALUES ($1, 'Submit REST course', $2)", [courseId, `sub-${courseId}`]);
    testId = randomUUID();
    await q(
      `INSERT INTO public.self_tests
         (id, student_id, course_id, subject_id, test_type, chapter_ids, topic_ids, title, scheduled_at, duration_minutes,
          total_questions, mcq_count, written_count, status)
       VALUES ($1, $2, $3, $4, 'chapter', '{}', '{}', 'Submit REST test', now() - interval '5 minutes', 30, 3, 2, 1, 'scheduled')`,
      [testId, owner.id, courseId, ref.subject_id]
    );
    const mk = async (key, order, section, correct, marks) => {
      questionIds[key] = randomUUID();
      await q(
        `INSERT INTO public.self_test_questions (id, self_test_id, order_number, section, question_text, correct_answer, marks)
         VALUES ($1, $2, $3, $4, 'q', $5, $6)`,
        [questionIds[key], testId, order, section, correct, marks]
      );
    };
    await mk("mcqRight", 1, "mcq", "C", 4);
    await mk("mcqWrong", 2, "mcq", "B", 4);
    await mk("mcqBlank", 3, "mcq", "D", 4);
    await mk("written", 4, "written", "Reference text", 4);
  });

  after(async () => {
    if (testId) await q("DELETE FROM public.self_tests WHERE id = $1", [testId]);
    if (courseId) await q("DELETE FROM public.courses WHERE id = $1", [courseId]);
    await stopServer();
  });

  const h = (prefer) => ({
    apikey: "anon-placeholder",
    Authorization: `Bearer ${owner.access}`,
    "Content-Type": "application/json",
    Prefer: prefer,
  });

  it("saves one answer row per question and scores the MCQs on submit", async () => {
    // Same row shape the hook builds: every question, unanswered ones included.
    const row = (qid, mcqCorrect, selected, text, isCorrect, awarded, max) => ({
      self_test_id: testId,
      self_test_question_id: qid,
      student_id: owner.id,
      chapter_id: null,
      topic_id: null,
      selected_option: selected,
      answer_text: text,
      answer_image_url: null,
      is_correct: isCorrect,
      marks_awarded: awarded,
      max_marks: max,
      ai_feedback: null,
      extracted_text: null,
    });
    const rows = [
      row(questionIds.mcqRight, true, "C", null, true, 4, 4),
      row(questionIds.mcqWrong, true, "A", null, false, 0, 4),
      row(questionIds.mcqBlank, true, null, null, false, 0, 4),
      row(questionIds.written, false, null, "Some written answer", false, 2, 4),
    ];

    const up = await fetch(`${base}/rest/v1/self_test_answers?on_conflict=self_test_question_id,student_id`, {
      method: "POST",
      headers: h("resolution=merge-duplicates,return=minimal"),
      body: JSON.stringify(rows),
    });
    assert.ok(up.status < 300, `upsert failed: ${up.status} ${await up.text()}`);

    const patch = await fetch(`${base}/rest/v1/self_tests?id=eq.${testId}`, {
      method: "PATCH",
      headers: h("return=minimal"),
      body: JSON.stringify({
        submitted_at: new Date().toISOString(),
        mcq_score: 1,
        written_score: 2,
        total_score: 6,
        total_max_marks: 16,
        percentage: 38,
        status: "submitted",
      }),
    });
    assert.ok(patch.status < 300, `submit update failed: ${patch.status} ${await patch.text()}`);

    // Read back the way MyTestResult does, through the REST layer.
    const read = await fetch(`${base}/rest/v1/self_test_answers?self_test_id=eq.${testId}&select=*`, { headers: h("return=representation") });
    const saved = await read.json();
    assert.equal(saved.length, 4, "every question has an answer row");

    const byQ = Object.fromEntries(saved.map((r) => [r.self_test_question_id, r]));
    assert.equal(byQ[questionIds.mcqRight].is_correct, true);
    assert.equal(Number(byQ[questionIds.mcqRight].marks_awarded), 4);
    assert.equal(byQ[questionIds.mcqWrong].is_correct, false);
    assert.equal(Number(byQ[questionIds.mcqWrong].marks_awarded), 0);
    assert.equal(byQ[questionIds.mcqBlank].selected_option, null);
    assert.equal(byQ[questionIds.written].answer_text, "Some written answer");

    const [test] = await q("SELECT submitted_at, mcq_score, written_score, total_score, percentage, status FROM public.self_tests WHERE id = $1", [testId]);
    assert.ok(test.submitted_at, "submitted_at is set");
    assert.equal(Number(test.mcq_score), 1);
    assert.equal(Number(test.written_score), 2);
    assert.equal(Number(test.total_score), 6);
    assert.equal(Number(test.percentage), 38);
    assert.equal(test.status, "submitted");
  });

  it("a second submit updates the same rows instead of duplicating them", async () => {
    const up = await fetch(`${base}/rest/v1/self_test_answers?on_conflict=self_test_question_id,student_id`, {
      method: "POST",
      headers: h("resolution=merge-duplicates,return=minimal"),
      body: JSON.stringify([
        {
          self_test_id: testId,
          self_test_question_id: questionIds.mcqWrong,
          student_id: owner.id,
          selected_option: "C",
          is_correct: true,
          marks_awarded: 4,
          max_marks: 4,
        },
      ]),
    });
    assert.ok(up.status < 300, `re-upsert failed: ${up.status} ${await up.text()}`);
    const [{ n }] = await q("SELECT count(*)::int AS n FROM public.self_test_answers WHERE self_test_id = $1", [testId]);
    assert.equal(n, 4);
    const [row] = await q("SELECT selected_option, is_correct FROM public.self_test_answers WHERE self_test_question_id = $1", [questionIds.mcqWrong]);
    assert.equal(row.selected_option, "C");
    assert.equal(row.is_correct, true);
  });
});
