import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { mountRouter, request, bearer, makeAdmin, uniqueTag } from "./group02-harness.js";
import { router } from "../functions/extract-dpp-page/index.js";
import { hooks as aiHooks } from "../functions/_shared/extract-dpp-helper.js";

const FAKE_ENDPOINT = { apiUrl: "http://ai.test/v1/chat/completions", apiKey: "stub-key", model: "stub-model", provider: "openai" };

// The AI answers with two MCQs in a tool call, as the extraction prompt asks.
const aiTwoQuestions = async () =>
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
                      { question_number: 1, question_text: "Solubility depends on?", options: { a: "Gas", b: "Temperature", c: "Pressure", d: "All" }, difficulty: "easy" },
                      { question_number: 2, question_text: "Speed of light?", options: { a: "3e8", b: "3e6", c: "", d: "1" }, difficulty: "hard" },
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

describe("extract-dpp-page", () => {
  let app;
  let admin;
  let student;
  let sourceDocId;
  let dppDocId;
  const tag = uniqueTag("dpppage");
  before(async () => {
    await startServer();
    app = await mountRouter("/functions/v1/extract-dpp-page", router);
    admin = await makeAdmin();
    student = await makeUser();
    const [cat] = await q("SELECT id FROM public.categories LIMIT 1");
    const [ch] = await q("SELECT id, subject_id FROM public.subject_chapters WHERE subject_id IS NOT NULL LIMIT 1");
    const [doc] = await q(
      `INSERT INTO public.uploaded_question_documents
         (category_id, subject_id, chapter_id, uploaded_by, file_type, file_name, file_url)
       VALUES ($1, $2, $3, $4, 'pdf', $5, 'https://files.test/page.pdf') RETURNING id`,
      [cat.id, ch.subject_id, ch.id, admin.id, `${tag}.pdf`]
    );
    sourceDocId = doc.id;
    const [dpp] = await q(
      "INSERT INTO public.dpp_documents (subject_id, display_name, status, created_by) VALUES ($1, $2, 'processing', $3) RETURNING id",
      [ch.subject_id, tag, admin.id]
    );
    dppDocId = dpp.id;
  });
  after(async () => {
    try {
      await q("DELETE FROM public.questions WHERE source_document_id = $1", [sourceDocId]);
      await q("DELETE FROM public.dpp_documents WHERE id = $1", [dppDocId]);
      await q("DELETE FROM public.uploaded_question_documents WHERE id = $1", [sourceDocId]);
      await q("DELETE FROM public.user_roles WHERE user_id = $1", [admin.id]);
    } finally {
      aiHooks.endpoint = undefined;
      aiHooks.fetch = null;
      await app.close();
      await stopServer();
    }
  });

  const page = { pageNumber: 3, pageContent: "1. Solubility depends on?\n- (a) Gas\n- (b) Temperature", sourceDocumentId: null, dppDocumentId: null };

  it("requires an admin", async () => {
    assert.equal((await request(app.base, { body: page })).status, 401);
    assert.equal((await request(app.base, { body: page, headers: bearer(student.access) })).status, 403);
  });

  it("requires pageNumber and pageContent, and at least one document id", async () => {
    const h = bearer(admin.access);
    assert.equal((await request(app.base, { body: { pageNumber: 1 }, headers: h })).status, 400);
    const noIds = await request(app.base, { body: { pageNumber: 1, pageContent: "x" }, headers: h });
    assert.equal(noIds.status, 400);
    assert.match(noIds.body.error, /provide sourceDocumentId/);
  });

  it("returns 500 when no AI provider is configured", async () => {
    aiHooks.endpoint = null;
    const r = await request(app.base, {
      body: { ...page, sourceDocumentId: sourceDocId, dppDocumentId: dppDocId },
      headers: bearer(admin.access),
    });
    assert.equal(r.status, 500);
    assert.match(r.body.error, /AI API not configured/);
  });

  it("saves the extracted MCQs against the source document and records the page progress", async () => {
    aiHooks.endpoint = FAKE_ENDPOINT;
    aiHooks.fetch = aiTwoQuestions;
    const r = await request(app.base, {
      body: { ...page, sourceDocumentId: sourceDocId, dppDocumentId: dppDocId, topicId: null, chapterId: null },
      headers: bearer(admin.access),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.questionsFound, 2);
    assert.equal(r.body.pageNumber, 3);

    const rows = await q(
      "SELECT question_text, options, difficulty, source_document_purpose FROM public.questions WHERE source_document_id = $1 ORDER BY question_text",
      [sourceDocId]
    );
    assert.equal(rows.length, 2);
    const solubility = rows.find((x) => x.question_text === "Solubility depends on?");
    assert.equal(solubility.options.b, "Temperature");
    assert.equal(solubility.difficulty, "Low");
    assert.equal(solubility.source_document_purpose, "dpp");
    assert.equal(rows.find((x) => x.question_text === "Speed of light?").options.a, "3e8");

    const [doc] = await q("SELECT current_page FROM public.dpp_documents WHERE id = $1", [dppDocId]);
    assert.equal(doc.current_page, 3);
  });

  it("refuses a source document id that does not exist", async () => {
    aiHooks.fetch = aiTwoQuestions;
    const r = await request(app.base, {
      body: { ...page, sourceDocumentId: "00000000-0000-4000-8000-000000000005" },
      headers: bearer(admin.access),
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Invalid sourceDocumentId/);
  });
});
