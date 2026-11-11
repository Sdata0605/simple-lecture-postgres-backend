import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { mountRouter, request, bearer, makeAdmin, uniqueTag } from "./group02-harness.js";
import { router } from "../functions/extract-dpp-questions/index.js";
import { hooks as aiHooks } from "../functions/_shared/extract-dpp-helper.js";

const FAKE_ENDPOINT = { apiUrl: "http://ai.test/v1/chat/completions", apiKey: "stub-key", model: "stub-model", provider: "openai" };

const aiOneQuestion = async () =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: {
                  arguments: JSON.stringify({
                    questions: [
                      {
                        dpp_number: 1,
                        question_number: 1,
                        question_text: "What is 2 + 2?",
                        options: [
                          { id: "A", text: "3" },
                          { id: "B", text: "4" },
                          { id: "C", text: "5" },
                          { id: "D", text: "6" },
                        ],
                        correct_answer: "b",
                        difficulty: "easy",
                      },
                    ],
                  }),
                },
              },
            ],
          },
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );

describe("extract-dpp-questions", () => {
  let app;
  let admin;
  let student;
  let docId;
  const tag = uniqueTag("dppq");
  before(async () => {
    await startServer();
    app = await mountRouter("/functions/v1/extract-dpp-questions", router);
    admin = await makeAdmin();
    student = await makeUser();
    const [ch] = await q("SELECT id, subject_id FROM public.subject_chapters WHERE subject_id IS NOT NULL LIMIT 1");
    const [cat] = await q("SELECT id FROM public.categories LIMIT 1");
    // The DPP document id is also used as source_document_id for the questions, which must reference
    // uploaded_question_documents. So the same id is used for both rows.
    docId = (await q("SELECT gen_random_uuid() AS id"))[0].id;
    await q(
      `INSERT INTO public.uploaded_question_documents
         (id, category_id, subject_id, chapter_id, uploaded_by, file_type, file_name, file_url)
       VALUES ($1, $2, $3, $4, $5, 'pdf', $6, 'https://files.test/dpp.pdf')`,
      [docId, cat.id, ch.subject_id, ch.id, admin.id, `${tag}.pdf`]
    );
    await q("INSERT INTO public.dpp_documents (id, subject_id, display_name, status, created_by) VALUES ($1, $2, $3, 'pending', $4)", [
      docId,
      ch.subject_id,
      tag,
      admin.id,
    ]);
  });
  after(async () => {
    try {
      await q("DELETE FROM public.questions WHERE source_document_id = $1", [docId]);
      await q("DELETE FROM public.dpp_documents WHERE id = $1", [docId]);
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
    assert.equal((await request(app.base, { body: { documentId: docId }, headers: bearer(student.access) })).status, 403);
  });

  it("requires documentId and returns 404 for an unknown document", async () => {
    const h = bearer(admin.access);
    assert.equal((await request(app.base, { body: {}, headers: h })).status, 400);
    const r = await request(app.base, { body: { documentId: "00000000-0000-4000-8000-000000000006" }, headers: h });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "Document not found");
  });

  it("marks the document failed and returns 500 when the AI is not configured", async () => {
    aiHooks.endpoint = null;
    const r = await request(app.base, {
      body: { documentId: docId, parsedContent: { questionsMmd: "1. What is 2 + 2?" } },
      headers: bearer(admin.access),
    });
    assert.equal(r.status, 500);
    assert.match(r.body.error, /AI API not configured/);
    const [doc] = await q("SELECT status, error_message FROM public.dpp_documents WHERE id = $1", [docId]);
    assert.equal(doc.status, "failed");
    assert.match(doc.error_message, /AI API not configured/);
  });

  it("extracts questions from the markdown, stores them and returns a preview", async () => {
    aiHooks.endpoint = FAKE_ENDPOINT;
    aiHooks.fetch = aiOneQuestion;
    const r = await request(app.base, {
      body: { documentId: docId, parsedContent: { questionsMmd: "1. What is 2 + 2?\n(a) 3 (b) 4 (c) 5 (d) 6" } },
      headers: bearer(admin.access),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.questionsCount, 1);
    assert.equal(r.body.questions.length, 1);

    const rows = await q("SELECT question_text, options, correct_answer, difficulty FROM public.questions WHERE source_document_id = $1", [docId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].options.b, "4");
    assert.equal(rows[0].correct_answer, "b");
    assert.equal(rows[0].difficulty, "Low");

    const [doc] = await q("SELECT status, questions_count FROM public.dpp_documents WHERE id = $1", [docId]);
    assert.equal(doc.status, "completed");
    assert.equal(doc.questions_count, 1);
  });
});
