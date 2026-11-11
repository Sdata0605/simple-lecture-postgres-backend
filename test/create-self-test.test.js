import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { mountRouter, request, bearer, uniqueTag } from "./group02-harness.js";
import { router } from "../functions/create-self-test/index.js";

describe("create-self-test", () => {
  let app;
  let student;
  let courseId;
  let subjectId;
  let chapterId;
  const tag = uniqueTag("selftest");
  before(async () => {
    await startServer();
    app = await mountRouter("/functions/v1/create-self-test", router);
    student = await makeUser();
    [{ id: courseId }] = await q("SELECT id FROM public.courses LIMIT 1");
    const [ch] = await q("SELECT id, subject_id FROM public.subject_chapters WHERE subject_id IS NOT NULL LIMIT 1");
    chapterId = ch.id;
    subjectId = ch.subject_id;
    // Three questions of our own in the chapter, so the test has known content.
    for (let i = 0; i < 3; i++) {
      await q(
        `INSERT INTO public.questions (chapter_id, question_text, question_type, question_format, options, correct_answer, marks, is_verified)
         VALUES ($1, $2, 'mcq', 'single_choice', $3::jsonb, 'a', 1, true)`,
        [chapterId, `${tag} question ${i}`, JSON.stringify({ a: "one", b: "two", c: "three", d: "four" })]
      );
    }
  });
  after(async () => {
    try {
      await q("DELETE FROM public.study_timetable_sessions WHERE student_id = $1", [student.id]);
      await q("DELETE FROM public.self_tests WHERE student_id = $1", [student.id]);
      await q("DELETE FROM public.study_timetables WHERE student_id = $1", [student.id]);
      await q("DELETE FROM public.questions WHERE question_text LIKE $1", [`${tag}%`]);
    } finally {
      await app.close();
      await stopServer();
    }
  });

  const valid = () => ({
    courseId,
    subjectId,
    testType: "chapter",
    chapterIds: [chapterId],
    topicIds: [],
    title: `${tag} chapter test`,
    scheduledAt: new Date().toISOString(),
    durationMinutes: 60,
  });

  it("requires a signed-in student", async () => {
    const r = await request(app.base, { body: valid() });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "Not authenticated");
  });

  it("validates required fields and the test type", async () => {
    const h = bearer(student.access);
    assert.equal((await request(app.base, { body: { ...valid(), durationMinutes: 0 }, headers: h })).body.error, "Missing fields");
    assert.equal((await request(app.base, { body: { ...valid(), testType: "mock" }, headers: h })).body.error, "Invalid testType");
    assert.equal((await request(app.base, { body: { ...valid(), testType: "topic" }, headers: h })).body.error, "Pick at least one topic");
    assert.equal((await request(app.base, { body: { ...valid(), chapterIds: [] }, headers: h })).body.error, "Pick at least one chapter");
  });

  it("returns 400 when the chosen scope has no questions", async () => {
    const r = await request(app.base, {
      body: { ...valid(), chapterIds: ["00000000-0000-4000-8000-000000000001"] },
      headers: bearer(student.access),
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /No questions found/);
  });

  it("builds a scheduled test from the chapter, snapshots its questions and adds a session", async () => {
    const r = await request(app.base, { body: valid(), headers: bearer(student.access) });
    assert.equal(r.status, 200);
    assert.ok(r.body.totalQuestions >= 3);
    assert.equal(r.body.totalQuestions, r.body.mcqCount + r.body.writtenCount);

    const [test] = await q("SELECT student_id, status, total_questions, test_type FROM public.self_tests WHERE id = $1", [r.body.id]);
    assert.equal(test.student_id, student.id);
    assert.equal(test.status, "scheduled");
    assert.equal(test.test_type, "chapter");
    assert.equal(test.total_questions, r.body.totalQuestions);

    const [snap] = await q("SELECT COUNT(*)::int AS n FROM public.self_test_questions WHERE self_test_id = $1", [r.body.id]);
    assert.equal(snap.n, r.body.totalQuestions);

    const [session] = await q("SELECT session_type FROM public.study_timetable_sessions WHERE self_test_id = $1", [r.body.id]);
    assert.equal(session.session_type, "test");
  });
});
