import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { mountRouter, request, bearer, makeAdmin, uniqueTag } from "./group02-harness.js";
import { router } from "../functions/deduplicate-questions/index.js";

describe("deduplicate-questions", () => {
  let app;
  let admin;
  let chapterId;
  let topicId;
  const tag = uniqueTag("dedupe");
  const adminIds = [];
  before(async () => {
    await startServer();
    app = await mountRouter("/functions/v1/deduplicate-questions", router);
    admin = await makeAdmin();
    adminIds.push(admin.id);
    const [sub] = await q("SELECT subject_id FROM public.subject_chapters WHERE subject_id IS NOT NULL LIMIT 1");
    // A fresh chapter and topic, so only this test's questions are in scope.
    const [ch] = await q(
      "INSERT INTO public.subject_chapters (subject_id, chapter_number, title) VALUES ($1, $2, $3) RETURNING id",
      [sub.subject_id, 80000 + Math.floor(Math.random() * 9000), `${tag} chapter`]
    );
    chapterId = ch.id;
    const [t] = await q(
      "INSERT INTO public.subject_topics (chapter_id, topic_number, title) VALUES ($1, '1', $2) RETURNING id",
      [chapterId, `${tag} topic`]
    );
    topicId = t.id;
  });
  after(async () => {
    try {
      await q("DELETE FROM public.questions WHERE topic_id = $1", [topicId]);
      await q("DELETE FROM public.subject_chapters WHERE id = $1", [chapterId]);
      await q("DELETE FROM public.user_roles WHERE user_id = ANY($1)", [adminIds]);
    } finally {
      await app.close();
      await stopServer();
    }
  });

  it("requires a signed-in admin", async () => {
    assert.equal((await request(app.base, { body: { topicId } })).status, 401);
    const u = await makeUser();
    assert.equal((await request(app.base, { body: { topicId }, headers: bearer(u.access) })).status, 403);
  });

  it("removes repeated questions in the chosen topic and keeps the first one", async () => {
    const texts = [`${tag} What is  X?`, `  ${tag} what is x? `, `${tag} What is X?`, `${tag} Something else`];
    for (const text of texts) {
      await q(
        `INSERT INTO public.questions (topic_id, chapter_id, question_text, question_type, correct_answer)
         VALUES ($1, $2, $3, 'mcq', 'a')`,
        [topicId, chapterId, text]
      );
      await new Promise((r) => setTimeout(r, 5)); // distinct created_at values
    }

    const r = await request(app.base, { body: { topicId }, headers: bearer(admin.access) });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.duplicatesRemoved, 2);

    const left = await q("SELECT question_text FROM public.questions WHERE topic_id = $1 ORDER BY created_at", [topicId]);
    assert.equal(left.length, 2);
    assert.match(left[0].question_text, /What is  X\?/);
  });

  it("reports nothing to do for a subject that has no chapters and never widens the scope", async () => {
    const r = await request(app.base, {
      body: { subjectId: "00000000-0000-4000-8000-000000000003" },
      headers: bearer(admin.access),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.duplicatesRemoved, 0);
    assert.equal(r.body.message, "No questions found to deduplicate");
  });
});
