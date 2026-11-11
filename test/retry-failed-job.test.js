import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { router } from "../functions/retry-failed-job/index.js";

// Downstream routes (llm-verify-questions, extract-questions-from-document) are replaced by a local stub.
let stub;
let stubStatus = 200;
let stubHits = [];
let fnServer;
let fnBase;
const savedBase = process.env.PUBLIC_BASE_URL;
const jobIds = [];
const docIds = [];

async function retry(body, headers) {
  const res = await fetch(`${fnBase}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(headers || {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

let sharedDoc;
async function makeJob({ type = "llm_verification", retry_count = 0, max_retries = 3, docId = null } = {}) {
  const id = randomUUID();
  jobIds.push(id);
  await q(
    `INSERT INTO public.document_processing_jobs (id, document_id, job_type, status, retry_count, max_retries, error_message)
     VALUES ($1, $2, $3, 'failed', $4, $5, 'earlier failure')`,
    [id, docId ?? sharedDoc, type, retry_count, max_retries]
  );
  return id;
}

async function makeDoc(uploader) {
  const [ref] = await q(
    "SELECT ch.id AS chapter_id, s.id AS subject_id, s.category_id FROM public.subject_chapters ch JOIN public.popular_subjects s ON s.id = ch.subject_id LIMIT 1"
  );
  const id = randomUUID();
  docIds.push(id);
  await q(
    `INSERT INTO public.uploaded_question_documents (id, category_id, subject_id, chapter_id, uploaded_by, file_type, file_name, file_url)
     VALUES ($1, $2, $3, $4, $5, 'pdf', 'p.pdf', 'http://localhost/p.pdf')`,
    [id, ref.category_id, ref.subject_id, ref.chapter_id, uploader.id]
  );
  return id;
}

describe("retry-failed-job", () => {
  before(async () => {
    await startServer();
    sharedDoc = await makeDoc(await makeUser());
    stub = http.createServer((req, res) => {
      stubHits.push(req.url);
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(stubStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: stubStatus === 200 }));
      });
    });
    stub.listen(0, "127.0.0.1");
    await once(stub, "listening");
    process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${stub.address().port}`;

    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/", router);
    fnServer = app.listen(0, "127.0.0.1");
    await once(fnServer, "listening");
    fnBase = `http://127.0.0.1:${fnServer.address().port}`;
  });

  after(async () => {
    try {
      if (jobIds.length) {
        await q("DELETE FROM public.job_logs WHERE job_id = ANY($1)", [jobIds]);
        await q("DELETE FROM public.document_processing_jobs WHERE id = ANY($1)", [jobIds]);
      }
      if (docIds.length) {
        await q("DELETE FROM public.uploaded_question_documents WHERE id = ANY($1)", [docIds]);
      }
    } finally {
      if (savedBase === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = savedBase;
      await new Promise((r) => fnServer.close(r));
      await new Promise((r) => stub.close(r));
      await stopServer();
    }
  });

  it("refuses an unauthenticated request", async () => {
    const id = await makeJob();
    const r = await retry({ jobId: id });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "Unauthorized");
    const [job] = await q("SELECT retry_count FROM public.document_processing_jobs WHERE id = $1", [id]);
    assert.equal(job.retry_count, 0);
  });

  it("reports an unknown job", async () => {
    const u = await makeUser();
    const r = await retry({ jobId: randomUUID() }, { Authorization: `Bearer ${u.access}` });
    assert.equal(r.body.error, "Job not found");
  });

  it("refuses once the retry limit is reached", async () => {
    const u = await makeUser();
    const id = await makeJob({ retry_count: 3, max_retries: 3 });
    const r = await retry({ jobId: id }, { Authorization: `Bearer ${u.access}` });
    assert.equal(r.body.error, "Maximum retry attempts (3) exceeded");
    const [job] = await q("SELECT retry_count, status FROM public.document_processing_jobs WHERE id = $1", [id]);
    assert.equal(job.retry_count, 3);
    assert.equal(job.status, "failed");
  });

  it("retries a verification job: resets it, bumps retry_count, and re-triggers verification", async () => {
    const u = await makeUser();
    const id = await makeJob({ type: "llm_verification", retry_count: 1 });
    stubStatus = 200;
    stubHits = [];
    const r = await retry({ jobId: id }, { Authorization: `Bearer ${u.access}` });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
      success: true,
      message: "Job retry 2/3 initiated",
      jobId: id,
    });
    assert.ok(stubHits.includes("/functions/v1/llm-verify-questions"));
    const [job] = await q("SELECT status, retry_count, error_message FROM public.document_processing_jobs WHERE id = $1", [id]);
    assert.equal(job.retry_count, 2);
    assert.equal(job.error_message, null);
    const logs = await q("SELECT message FROM public.job_logs WHERE job_id = $1 ORDER BY created_at", [id]);
    assert.deepEqual(logs.map((l) => l.message), ["Retry attempt 2/3", "Job retry triggered successfully"]);
  });

  it("reports a downstream failure as an error (the job stays reset)", async () => {
    const u = await makeUser();
    const id = await makeJob({ type: "llm_verification" });
    stubStatus = 503;
    try {
      const r = await retry({ jobId: id }, { Authorization: `Bearer ${u.access}` });
      assert.equal(r.status, 500);
      assert.match(r.body.error, /^Failed to invoke function: llm-verify-questions responded 503/);
    } finally {
      stubStatus = 200;
    }
  });

  it("re-runs an extraction job using the document's category, subject and chapter", async () => {
    const u = await makeUser();
    const id = await makeJob({ type: "llm_extraction" });
    stubHits = [];
    const r = await retry({ jobId: id }, { Authorization: `Bearer ${u.access}` });
    assert.equal(r.body.success, true);
    assert.ok(stubHits.includes("/functions/v1/extract-questions-from-document"));
  });

  it("a mathpix retry fails clearly, because process-uploaded-document has been removed", async () => {
    const u = await makeUser();
    const id = await makeJob({ type: "mathpix_processing" });
    const r = await retry({ jobId: id }, { Authorization: `Bearer ${u.access}` });
    assert.equal(r.status, 500);
    assert.match(r.body.error, /has been removed/);
  });
});
