import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { mountRouter, request, bearer, makeAdmin, uniqueTag } from "./group02-harness.js";
import { router } from "../functions/export-verification-report/index.js";

describe("export-verification-report", () => {
  let app;
  let admin;
  let docId;
  let refs;
  const tag = uniqueTag("verify");
  before(async () => {
    await startServer();
    app = await mountRouter("/functions/v1/export-verification-report", router);
    admin = await makeAdmin();
    const [cat] = await q("SELECT id FROM public.categories LIMIT 1");
    const [ch] = await q("SELECT id, subject_id FROM public.subject_chapters WHERE subject_id IS NOT NULL LIMIT 1");
    refs = { category: cat.id, subject: ch.subject_id, chapter: ch.id };
    const [doc] = await q(
      `INSERT INTO public.uploaded_question_documents
         (category_id, subject_id, chapter_id, uploaded_by, file_type, file_name, file_url,
          questions_file_name, questions_file_url, verification_quality_score)
       VALUES ($1, $2, $3, $4, 'pdf', $5, 'https://files.test/doc.pdf', $5, 'https://files.test/doc.pdf', 0.9)
       RETURNING id`,
      [refs.category, refs.subject, refs.chapter, admin.id, `${tag}.pdf`]
    );
    docId = doc.id;
    const rows = [
      { text: `${tag} first <b>q</b>`, approved: true, verified: true, conf: 0.9 },
      { text: `${tag} second`, approved: false, verified: false, conf: 0.5 },
    ];
    for (const r of rows) {
      await q(
        `INSERT INTO public.parsed_questions_pending
           (document_id, category_id, subject_id, chapter_id, question_text, question_type, question_format,
            difficulty, correct_answer, is_approved, llm_verified, llm_confidence_score)
         VALUES ($1, $2, $3, $4, $5, 'objective', 'single_choice', 'Medium', 'a', $6, $7, $8)`,
        [docId, refs.category, refs.subject, refs.chapter, r.text, r.approved, r.verified, r.conf]
      );
    }
  });
  after(async () => {
    try {
      await q("DELETE FROM public.parsed_questions_pending WHERE document_id = $1", [docId]);
      await q("DELETE FROM public.uploaded_question_documents WHERE id = $1", [docId]);
      await q("DELETE FROM public.user_roles WHERE user_id = $1", [admin.id]);
    } finally {
      await app.close();
      await stopServer();
    }
  });

  it("requires an admin", async () => {
    assert.equal((await request(app.base, { body: { documentId: docId, format: "csv" } })).status, 401);
    const u = await makeUser();
    assert.equal((await request(app.base, { body: { documentId: docId, format: "csv" }, headers: bearer(u.access) })).status, 403);
  });

  it("validates documentId and format", async () => {
    const h = bearer(admin.access);
    assert.equal((await request(app.base, { body: { format: "csv" }, headers: h })).body.error, "documentId and format are required");
    assert.equal((await request(app.base, { body: { documentId: docId, format: "xlsx" }, headers: h })).body.error, "format must be csv or pdf");
  });

  it("returns a 500 with 'Document not found' for an unknown document", async () => {
    const r = await request(app.base, {
      body: { documentId: "00000000-0000-4000-8000-000000000004", format: "csv" },
      headers: bearer(admin.access),
    });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "Document not found");
  });

  it("exports a CSV attachment with one row per question", async () => {
    const r = await request(app.base, { body: { documentId: docId, format: "csv" }, headers: bearer(admin.access) });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /text\/csv/);
    assert.match(r.headers.get("content-disposition"), /verification-report-.*\.csv/);
    const lines = String(r.body).split("\n");
    assert.equal(lines[0].startsWith("Question #,Question Text"), true);
    assert.equal(lines.length, 3);
    assert.match(lines[1], /^1,"/);
  });

  it("returns an HTML report with the metrics and escaped question text", async () => {
    const r = await request(app.base, { body: { documentId: docId, format: "pdf" }, headers: bearer(admin.access) });
    assert.equal(r.status, 200);
    const html = r.body.html;
    assert.match(html, /Document Verification Report/);
    assert.match(html, /Total Questions<\/div>\s*<div class="metric-value">2</);
    assert.match(html, /Approved by Human<\/div>\s*<div class="metric-value">1</);
    assert.match(html, /90\.0%/);
    assert.ok(!html.includes("<b>q</b>"));
    assert.ok(html.includes("&lt;b&gt;q&lt;/b&gt;"));
  });
});
