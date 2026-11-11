import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { mountRouter, request, bearer, makeAdmin, uniqueTag } from "./group02-harness.js";
import { router } from "../functions/check-replit-job-status/index.js";
import { hooks as helperHooks } from "../functions/_shared/extract-dpp-helper.js";

// Stub for the Replit service. `replies` maps a path prefix to a { status, body } reply.
function replitStub(replies) {
  return async (url) => {
    const path = new URL(String(url)).pathname;
    const key = Object.keys(replies).find((k) => path.startsWith(k));
    const reply = replies[key] || { status: 404, body: {} };
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  };
}

describe("check-replit-job-status", () => {
  let app;
  let admin;
  let student;
  let docId;
  let categoryId;
  let subjectId;
  let chapterId;
  const tag = uniqueTag("replit");
  const jobIds = [];
  const saved = process.env.MATHPIX_REPLIT_BASE_URL;

  before(async () => {
    process.env.MATHPIX_REPLIT_BASE_URL = "http://replit.test";
    await startServer();
    app = await mountRouter("/functions/v1/check-replit-job-status", router);
    admin = await makeAdmin();
    student = await makeUser();
    const [cat] = await q("SELECT id FROM public.categories LIMIT 1");
    categoryId = cat.id;
    const [ch] = await q("SELECT id, subject_id FROM public.subject_chapters WHERE subject_id IS NOT NULL LIMIT 1");
    chapterId = ch.id;
    subjectId = ch.subject_id;
    const [doc] = await q(
      `INSERT INTO public.uploaded_question_documents
         (category_id, subject_id, chapter_id, uploaded_by, file_type, file_name, file_url)
       VALUES ($1, $2, $3, $4, 'pdf', $5, 'https://files.test/replit.pdf') RETURNING id`,
      [categoryId, subjectId, chapterId, admin.id, `${tag}.pdf`]
    );
    docId = doc.id;
  });
  after(async () => {
    try {
      // Deleting the document removes its jobs, their logs and the parsed questions.
      await q("DELETE FROM public.uploaded_question_documents WHERE id = $1", [docId]);
      await q("DELETE FROM public.user_roles WHERE user_id = $1", [admin.id]);
    } finally {
      helperHooks.fetch = null;
      if (saved === undefined) delete process.env.MATHPIX_REPLIT_BASE_URL;
      else process.env.MATHPIX_REPLIT_BASE_URL = saved;
      await app.close();
      await stopServer();
    }
  });

  async function makeJob(replitJobId, status = "running") {
    const [{ id }] = await q(
      `INSERT INTO public.document_processing_jobs (document_id, job_type, status, result_data, progress_percentage, created_at)
       VALUES ($1, 'mathpix_processing', $2, $3::jsonb, 10, now()) RETURNING id`,
      [docId, status, JSON.stringify({ replit_job_id: replitJobId })]
    );
    jobIds.push(id);
    return id;
  }

  it("requires an admin", async () => {
    assert.equal((await request(app.base, { body: { jobId: "x" } })).status, 401);
    assert.equal((await request(app.base, { body: { jobId: "x" }, headers: bearer(student.access) })).status, 403);
  });

  it("requires a jobId and reports an unknown job", async () => {
    const h = bearer(admin.access);
    const none = await request(app.base, { body: {}, headers: h });
    assert.equal(none.status, 500);
    assert.equal(none.body.error, "Job ID is required");
    const unknown = await request(app.base, { body: { jobId: "00000000-0000-4000-8000-000000000007" }, headers: h });
    assert.equal(unknown.status, 500);
    assert.equal(unknown.body.error, "Job not found");
  });

  it("returns a finished job without calling the service", async () => {
    const jobId = await makeJob("rj-done-" + tag, "completed");
    helperHooks.fetch = async () => {
      throw new Error("service must not be called for a finished job");
    };
    const r = await request(app.base, { body: { jobId }, headers: bearer(admin.access) });
    assert.equal(r.status, 200);
    assert.equal(r.body.message, "Job is already completed");
  });

  it("keeps a job running while the service is still processing it", async () => {
    const replitId = "rj-proc-" + tag;
    const jobId = await makeJob(replitId);
    helperHooks.fetch = replitStub({ "/status/": { status: 200, body: { status: "PROCESSING" } } });
    const r = await request(app.base, { body: { jobId }, headers: bearer(admin.access) });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "processing");
    const [job] = await q("SELECT status, current_step, progress_percentage FROM public.document_processing_jobs WHERE id = $1", [jobId]);
    assert.equal(job.status, "running");
    assert.equal(job.current_step, "Still processing on Replit service");
    assert.equal(job.progress_percentage, 15);
    const logs = await q("SELECT message FROM public.job_logs WHERE job_id = $1", [jobId]);
    assert.ok(logs.some((l) => l.message === "Status check: PROCESSING"));
  });

  it("marks the job and document failed when the service no longer knows the job", async () => {
    const jobId = await makeJob("rj-gone-" + tag);
    helperHooks.fetch = replitStub({ "/status/": { status: 404, body: {} } });
    const r = await request(app.base, { body: { jobId }, headers: bearer(admin.access) });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, false);
    assert.equal(r.body.status, "failed");
    const [job] = await q("SELECT status FROM public.document_processing_jobs WHERE id = $1", [jobId]);
    assert.equal(job.status, "failed");
    const [doc] = await q("SELECT status FROM public.uploaded_question_documents WHERE id = $1", [docId]);
    assert.equal(doc.status, "failed");
  });

  it("stores the merged questions when the service has completed the job", async () => {
    const replitId = "rj-ok-" + tag;
    const jobId = await makeJob(replitId);
    helperHooks.fetch = replitStub({
      "/status/": { status: 200, body: { status: "COMPLETED" } },
      "/api/educational-result/": {
        status: 200,
        body: {
          result: {
            total_questions: 1,
            matched_count: 1,
            merged: [
              {
                question_number: 1,
                question_text: "1. Which? (a) one (b) two",
                matched_solution: { answer_key: "a", text: "Because one" },
              },
            ],
          },
        },
      },
    });
    const r = await request(app.base, { body: { jobId }, headers: bearer(admin.access) });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "completed");
    assert.equal(r.body.questionsInserted, 1);

    const [job] = await q("SELECT status, questions_extracted FROM public.document_processing_jobs WHERE id = $1", [jobId]);
    assert.equal(job.status, "completed");
    assert.equal(job.questions_extracted, 1);

    const [pq] = await q(
      "SELECT question_text, question_format, options, correct_answer, explanation FROM public.parsed_questions_pending WHERE document_id = $1",
      [docId]
    );
    assert.equal(pq.question_text, "Which?");
    assert.equal(pq.question_format, "single_choice");
    assert.equal(pq.options.b, "two");
    assert.equal(pq.correct_answer, "a");
    assert.equal(pq.explanation, "Because one");
  });
});
