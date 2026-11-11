import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { mountRouter, request, bearer, stubFetch, uniqueTag } from "./group02-harness.js";
import { router, hooks } from "../functions/check-chapter-completion/index.js";

describe("check-chapter-completion", () => {
  let app;
  let student;
  let courseId;
  let subjectId;
  let chapterId;
  let topicId;
  let docId;
  let jobId;
  let selfTestId;
  const tag = uniqueTag("chapter");
  const savedBase = process.env.PUBLIC_BASE_URL;

  before(async () => {
    process.env.PUBLIC_BASE_URL = "http://api.test";
    await startServer();
    app = await mountRouter("/functions/v1/check-chapter-completion", router);
    student = await makeUser();
    [{ id: courseId }] = await q("SELECT id FROM public.courses LIMIT 1");
    const [sub] = await q("SELECT subject_id FROM public.subject_chapters WHERE subject_id IS NOT NULL LIMIT 1");
    subjectId = sub.subject_id;
    // A fresh chapter with one topic, so no existing data is touched.
    const [ch] = await q(
      "INSERT INTO public.subject_chapters (subject_id, chapter_number, title) VALUES ($1, $2, $3) RETURNING id",
      [subjectId, 90000 + Math.floor(Math.random() * 9000), `${tag} chapter`]
    );
    chapterId = ch.id;
  });

  after(async () => {
    try {
      hooks.fetch = null;
      await q("DELETE FROM public.ai_video_watch_logs WHERE student_id = $1", [student.id]);
      await q("DELETE FROM public.auto_chapter_tests WHERE student_id = $1", [student.id]);
      await q("DELETE FROM public.self_tests WHERE student_id = $1", [student.id]);
      if (jobId) await q("DELETE FROM public.video_generation_jobs WHERE id = $1", [jobId]);
      if (docId) await q("DELETE FROM public.ai_assistant_documents WHERE id = $1", [docId]);
      await q("DELETE FROM public.subject_topics WHERE chapter_id = $1", [chapterId]);
      await q("DELETE FROM public.subject_chapters WHERE id = $1", [chapterId]);
    } finally {
      if (savedBase === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = savedBase;
      await app.close();
      await stopServer();
    }
  });

  const body = (extra = {}) => ({ chapterId, courseId, subjectId, ...extra });

  it("requires a signed-in user", async () => {
    const r = await request(app.base, { body: body() });
    assert.equal(r.status, 401);
  });

  it("validates chapterId, courseId and subjectId", async () => {
    const r = await request(app.base, { body: { chapterId }, headers: bearer(student.access) });
    assert.equal(r.status, 400);
  });

  it("returns 404 for an unknown chapter", async () => {
    const r = await request(app.base, {
      body: body({ chapterId: "00000000-0000-4000-8000-000000000002" }),
      headers: bearer(student.access),
    });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "Chapter not found");
  });

  it("reports no_topics and no_published_lectures before any lecture exists", async () => {
    const h = bearer(student.access);
    const none = await request(app.base, { body: body(), headers: h });
    assert.equal(none.body.reason, "no_topics");

    const [topic] = await q(
      "INSERT INTO public.subject_topics (chapter_id, topic_number, title) VALUES ($1, '1', $2) RETURNING id",
      [chapterId, `${tag} topic`]
    );
    topicId = topic.id;
    const unpublished = await request(app.base, { body: body(), headers: h });
    assert.equal(unpublished.body.reason, "no_published_lectures");
  });

  it("requires every published topic to be watched, then creates the chapter test once", async () => {
    const [doc] = await q(
      `INSERT INTO public.ai_assistant_documents (subject_id, topic_id, display_name, source_type, status)
       VALUES ($1, $2, $3, 'manual', 'completed') RETURNING id`,
      [subjectId, topicId, `${tag} doc`]
    );
    docId = doc.id;
    jobId = `cj-${Math.random().toString(36).slice(2, 7)}`; // varchar(9)
    await q(
      `INSERT INTO public.video_generation_jobs (id, subject_id, document_id, status, is_published)
       VALUES ($1, $2, $3, 'completed', true)`,
      [jobId, subjectId, docId]
    );

    const h = bearer(student.access);
    const notWatched = await request(app.base, { body: body(), headers: h });
    assert.equal(notWatched.body.reason, "topic_not_watched");
    assert.equal(notWatched.body.topicId, topicId);

    await q(
      "INSERT INTO public.ai_video_watch_logs (student_id, topic_id, subject_id, chapter_id, video_title) VALUES ($1, $2, $3, $4, 'v')",
      [student.id, topicId, subjectId, chapterId]
    );

    const [st] = await q(
      "INSERT INTO public.self_tests (student_id, course_id, subject_id, test_type, title, scheduled_at, duration_minutes, status) VALUES ($1, $2, $3, 'chapter', 'stub', now(), 60, 'scheduled') RETURNING id",
      [student.id, courseId, subjectId]
    );
    selfTestId = st.id;
    hooks.fetch = stubFetch(200, { id: selfTestId });

    const created = await request(app.base, { body: body(), headers: h });
    assert.equal(created.status, 200);
    assert.equal(created.body.completed, true);
    assert.equal(created.body.alreadyExisted, false);
    assert.equal(created.body.selfTestId, selfTestId);
    const call = hooks.fetch.calls[0];
    assert.equal(call.url, "http://api.test/functions/v1/create-self-test");
    assert.equal(call.init.headers.Authorization, h.Authorization);

    const again = await request(app.base, { body: body(), headers: h });
    assert.equal(again.body.alreadyExisted, true);
    assert.equal(hooks.fetch.calls.length, 1);
  });

  it("reports create_self_test_failed when the test cannot be created", async () => {
    const other = await makeUser();
    await q(
      "INSERT INTO public.ai_video_watch_logs (student_id, topic_id, subject_id, chapter_id, video_title) VALUES ($1, $2, $3, $4, 'v')",
      [other.id, topicId, subjectId, chapterId]
    );
    hooks.fetch = stubFetch(500, { error: "boom" });
    const r = await request(app.base, { body: body(), headers: bearer(other.access) });
    assert.equal(r.status, 500);
    assert.equal(r.body.reason, "create_self_test_failed");
    await q("DELETE FROM public.ai_video_watch_logs WHERE student_id = $1", [other.id]);
  });
});
