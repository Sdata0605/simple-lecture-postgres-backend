import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { mountRouter, request, bearer, makeAdmin, uniqueTag } from "./group02-harness.js";
import { router } from "../functions/extract-dpp-answers/index.js";
import { hooks as aiHooks } from "../functions/_shared/extract-dpp-helper.js";

describe("extract-dpp-answers", () => {
  let app;
  let admin;
  let docId;
  const tag = uniqueTag("dppans");
  before(async () => {
    await startServer();
    app = await mountRouter("/functions/v1/extract-dpp-answers", router);
    admin = await makeAdmin();
    const [cat] = await q("SELECT id FROM public.categories LIMIT 1");
    const [ch] = await q("SELECT id, subject_id FROM public.subject_chapters WHERE subject_id IS NOT NULL LIMIT 1");
    const [doc] = await q(
      `INSERT INTO public.uploaded_question_documents
         (category_id, subject_id, chapter_id, uploaded_by, file_type, file_name, file_url)
       VALUES ($1, $2, $3, $4, 'pdf', $5, 'https://files.test/ans.pdf') RETURNING id`,
      [cat.id, ch.subject_id, ch.id, admin.id, `${tag}.pdf`]
    );
    docId = doc.id;
    for (let i = 0; i < 2; i++) {
      await q(
        "INSERT INTO public.questions (source_document_id, question_text, question_type, correct_answer) VALUES ($1, $2, 'mcq', '')",
        [docId, `${tag} question ${i}`]
      );
    }
  });
  after(async () => {
    try {
      await q("DELETE FROM public.questions WHERE source_document_id = $1", [docId]);
      await q("DELETE FROM public.uploaded_question_documents WHERE id = $1", [docId]);
      await q("DELETE FROM public.user_roles WHERE user_id = $1", [admin.id]);
    } finally {
      aiHooks.endpoint = undefined;
      aiHooks.fetch = null;
      await app.close();
      await stopServer();
    }
  });

  it("requires an admin", async () => {
    assert.equal((await request(app.base, { body: { documentId: docId } })).status, 401);
    const u = await makeUser();
    assert.equal((await request(app.base, { body: { documentId: docId }, headers: bearer(u.access) })).status, 403);
  });

  it("requires documentId", async () => {
    const r = await request(app.base, { body: {}, headers: bearer(admin.access) });
    assert.equal(r.status, 400);
  });

  it("applies answers found by the regex patterns, in question order, without calling the AI", async () => {
    aiHooks.endpoint = null; // the AI must not be needed here
    aiHooks.fetch = async () => {
      throw new Error("AI must not be called when the regexes find enough answers");
    };
    const fullMmd = "ANSWER KEY\n1. A\n2. b\n\nOther text";
    const r = await request(app.base, { body: { documentId: docId, fullMmd }, headers: bearer(admin.access) });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.answersApplied, 2);
    assert.equal(r.body.totalQuestions, 2);
    assert.equal(r.body.missingAnswers, undefined);
    const rows = await q("SELECT correct_answer FROM public.questions WHERE source_document_id = $1", [docId]);
    assert.deepEqual(rows.map((x) => x.correct_answer).sort(), ["A", "B"]);
  });

  it("lists question numbers without an answer as missing", async () => {
    await q("UPDATE public.questions SET correct_answer = '' WHERE source_document_id = $1", [docId]);
    aiHooks.endpoint = null;
    const r = await request(app.base, { body: { documentId: docId, fullMmd: "no key here" }, headers: bearer(admin.access) });
    assert.equal(r.status, 200);
    assert.equal(r.body.answersApplied, 0);
    assert.deepEqual(r.body.missingAnswers, [1, 2]);
  });
});
