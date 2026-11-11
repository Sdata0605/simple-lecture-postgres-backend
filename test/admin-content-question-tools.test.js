// Question-tools and content admin screens: the approve/transfer step, and the worker endpoints the admin
// screens call with the admin's own token. No external service is reached: the worker tests stop before any render call.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, q, makeUser } from "./helpers.js";
import { mountRouter, request, makeAdmin, bearer } from "./group02-harness.js";
import { router as approveRouter } from "../functions/approve-and-transfer-questions/index.js";
import { router as kannadaRouter } from "../functions/kannada-queue-worker/index.js";
import { router as cdnWorkerRouter } from "../functions/cdn-presentation-refresh-worker/index.js";

const tag = `ADMIN-CONTENT-${Math.random().toString(36).slice(2, 8)}`;

describe("admin content question tools", () => {
  let approveApp;
  let kannadaApp;
  let cdnApp;
  let admin;
  let student;
  const docIds = [];
  let savedEnv;
  const ENV_NAMES = ["KANNADA_NORMAL_SERVER_IP", "KANNADA_CLOUD_SERVER_IP", "CDN_REFRESH_CRON_KEY", "CDN_RENDER_HOST"];

  before(async () => {
    await startServer();
    savedEnv = Object.fromEntries(ENV_NAMES.map((k) => [k, process.env[k]]));
    approveApp = await mountRouter("/functions/v1/approve-and-transfer-questions", approveRouter);
    kannadaApp = await mountRouter("/functions/v1/kannada-queue-worker", kannadaRouter);
    cdnApp = await mountRouter("/functions/v1/cdn-presentation-refresh-worker", cdnWorkerRouter);
    admin = await makeAdmin();
    student = await makeUser();
    // parsed_questions_pending.approved_by references teacher_profiles, so the approving admin needs a profile row.
    await q("INSERT INTO public.teacher_profiles (id, full_name) VALUES ($1, $2)", [admin.id, tag]);
  });

  after(async () => {
    try {
      for (const docId of docIds) {
        await q("DELETE FROM public.parsed_questions_pending WHERE document_id = $1", [docId]); // pending rows point at questions
        await q("DELETE FROM public.questions WHERE source_document_id = $1", [docId]);
        await q("DELETE FROM public.uploaded_question_documents WHERE id = $1", [docId]);
      }
      await q("DELETE FROM public.user_roles WHERE user_id = $1 AND role = 'admin'", [admin.id]);
      await q("DELETE FROM public.teacher_profiles WHERE id = $1", [admin.id]);
    } finally {
      for (const k of ENV_NAMES) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
      await approveApp?.close();
      await kannadaApp?.close();
      await cdnApp?.close();
      await stopServer();
    }
  });

  // Creates one pending question under a real subject, chapter and topic, and removes it again in `after`.
  async function makePendingQuestion() {
    const [ref] = await q(
      `SELECT t.id AS topic_id, c.id AS chapter_id, c.subject_id, s.category_id
         FROM public.subject_topics t
         JOIN public.subject_chapters c ON c.id = t.chapter_id
         JOIN public.popular_subjects s ON s.id = c.subject_id
        WHERE s.category_id IS NOT NULL
        LIMIT 1`
    );
    const [doc] = await q(
      `INSERT INTO public.uploaded_question_documents
         (category_id, subject_id, chapter_id, topic_id, uploaded_by, file_name, file_type, file_url)
       VALUES ($1, $2, $3, $4, $5, $6, 'pdf', 'http://test.invalid/doc.pdf') RETURNING id`,
      [ref.category_id, ref.subject_id, ref.chapter_id, ref.topic_id, admin.id, `${tag}.pdf`]
    );
    const docId = doc.id;
    docIds.push(docId);
    const [pq] = await q(
      `INSERT INTO public.parsed_questions_pending
         (document_id, category_id, subject_id, chapter_id, topic_id, question_text, question_format, question_type,
          difficulty, marks, options, correct_answer, explanation)
       VALUES ($1, $2, $3, $4, $5, $6, 'single_choice', 'subjective', 'Low', 1, $7::jsonb, 'a', 'test')
       RETURNING id`,
      [docId, ref.category_id, ref.subject_id, ref.chapter_id, ref.topic_id, `${tag} question`, JSON.stringify(["a", "b"])]
    );
    return pq.id;
  }

  it("approves a question with no proxy headers and stores no IP (inet column gets NULL)", async () => {
    const id = await makePendingQuestion();
    const r = await request(approveApp.base, { body: { questionIds: [id] }, headers: bearer(admin.access) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.transferredCount, 1);
    assert.equal(r.body.approvedBy, admin.id);
    assert.equal(r.body.approvedFrom, "unknown");
    const [row] = await q("SELECT is_approved, approved_ip_address, transferred_to_question_bank FROM public.parsed_questions_pending WHERE id = $1", [id]);
    assert.equal(row.is_approved, true);
    assert.equal(row.approved_ip_address, null);
    assert.equal(row.transferred_to_question_bank, true);
  });

  it("stores a forwarded client IP when one is sent", async () => {
    const id = await makePendingQuestion();
    const r = await request(approveApp.base, {
      body: { questionIds: [id] },
      headers: { ...bearer(admin.access), "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.approvedFrom, "203.0.113.7");
    const [row] = await q("SELECT host(approved_ip_address) AS ip FROM public.parsed_questions_pending WHERE id = $1", [id]);
    assert.equal(row.ip, "203.0.113.7");
  });

  it("kannada-queue-worker accepts the signed-in admin (Kick worker) and rejects other users", async () => {
    process.env.KANNADA_NORMAL_SERVER_IP = "";
    process.env.KANNADA_CLOUD_SERVER_IP = "";
    const ok = await request(kannadaApp.base, { body: {}, headers: bearer(admin.access) });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { ok: true, results: [] });
    const denied = await request(kannadaApp.base, { body: {}, headers: bearer(student.access) });
    assert.equal(denied.status, 401);
    const anon = await request(kannadaApp.base, { body: {} });
    assert.equal(anon.status, 401);
  });

  it("cdn-presentation-refresh-worker accepts the signed-in admin and still rejects other users", async () => {
    process.env.CDN_REFRESH_CRON_KEY = "admin-content-cron-key-0123456789";
    delete process.env.CDN_RENDER_HOST; // stops after the auth check, before any CDN request
    const admins = await request(cdnApp.base, { body: {}, headers: bearer(admin.access) });
    assert.equal(admins.status, 500);
    assert.equal(admins.body.error, "CDN_RENDER_HOST is not configured");
    const denied = await request(cdnApp.base, { body: {}, headers: bearer(student.access) });
    assert.equal(denied.status, 401);
    const wrongKey = await request(cdnApp.base, { body: {}, headers: { "x-cron-key": "wrong" } });
    assert.equal(wrongKey.status, 401);
  });
});
