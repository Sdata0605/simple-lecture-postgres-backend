import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { upload } from "../functions/_shared/storage.js";
import { router } from "../functions/process-educational-pdfs/index.js";

// The OCR service is replaced by a local stub (PROCESS_EDUCATIONAL_PDFS_URL). No real host is contacted.
let stub;
let stubBase;
let stubReplyStatus = 200;
let stubFields = [];
let fnServer;
let fnBase;
const savedEnv = {};
const BUCKET = "uploaded-question-documents";
const storageFolder = `test-${randomUUID()}`;
const docIds = [];

async function run(body, headers = {}) {
  const res = await fetch(fnBase + "/", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function makeDoc({ withFiles = true } = {}) {
  const u = await makeUser();
  const [ref] = await q(
    "SELECT ch.id AS chapter_id, s.id AS subject_id, s.category_id FROM public.subject_chapters ch JOIN public.popular_subjects s ON s.id = ch.subject_id LIMIT 1"
  );
  const id = randomUUID();
  docIds.push(id);
  const base = `${storageFolder}/${id}`;
  const qUrl = `http://localhost/storage/v1/object/public/${BUCKET}/${base}/questions.pdf`;
  const sUrl = `http://localhost/storage/v1/object/public/${BUCKET}/${base}/solutions.pdf`;
  await q(
    `INSERT INTO public.uploaded_question_documents
       (id, category_id, subject_id, chapter_id, uploaded_by, file_type, status,
        questions_file_name, questions_file_url, solutions_file_name, solutions_file_url, file_name, file_url)
     VALUES ($1, $2, $3, $4, $5, 'pdf', 'pending', 'questions.pdf', $6, 'solutions.pdf', $7, 'legacy.pdf', 'http://localhost/legacy')`,
    [id, ref.category_id, ref.subject_id, ref.chapter_id, u.id, withFiles ? qUrl : null, withFiles ? sUrl : null]
  );
  if (withFiles) {
    await upload(BUCKET, `${base}/questions.pdf`, Buffer.from("%PDF questions"));
    await upload(BUCKET, `${base}/solutions.pdf`, Buffer.from("%PDF solutions"));
  }
  return { id, user: u };
}

describe("process-educational-pdfs", () => {
  before(async () => {
    await startServer();
    for (const k of ["PROCESS_EDUCATIONAL_PDFS_URL", "JWT_SECRET"]) savedEnv[k] = process.env[k];

    stub = http.createServer((req, res) => {
      // Multipart bodies are only inspected by name here.
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("latin1");
        stubFields = ["questions_file", "solutions_file", "use_llm"].filter((f) => text.includes(`name="${f}"`));
        res.writeHead(stubReplyStatus, { "Content-Type": "application/json" });
        res.end(stubReplyStatus === 200 ? JSON.stringify({ job_id: "replit-123" }) : "service down");
      });
    });
    stub.listen(0, "127.0.0.1");
    await once(stub, "listening");
    stubBase = `http://127.0.0.1:${stub.address().port}`;
    process.env.PROCESS_EDUCATIONAL_PDFS_URL = `${stubBase}/process-educational-content`;

    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/", router);
    fnServer = app.listen(0, "127.0.0.1");
    await once(fnServer, "listening");
    fnBase = `http://127.0.0.1:${fnServer.address().port}`;
  });

  after(async () => {
    try {
      if (docIds.length) {
        await q("UPDATE public.uploaded_question_documents SET current_job_id = NULL WHERE id = ANY($1)", [docIds]);
        await q("DELETE FROM public.job_logs WHERE job_id IN (SELECT id FROM public.document_processing_jobs WHERE document_id = ANY($1))", [docIds]);
        await q("DELETE FROM public.document_processing_jobs WHERE document_id = ANY($1)", [docIds]);
        await q("DELETE FROM public.uploaded_question_documents WHERE id = ANY($1)", [docIds]);
      }
      await fs.rm(path.join(process.cwd(), "storage-data", BUCKET, storageFolder), { recursive: true, force: true });
    } finally {
      for (const k of Object.keys(savedEnv)) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
      await new Promise((r) => fnServer.close(r));
      await new Promise((r) => stub.close(r));
      await stopServer();
    }
  });

  it("answers OPTIONS", async () => {
    const res = await fetch(fnBase + "/", { method: "OPTIONS" });
    assert.equal(res.status, 200);
  });

  it("rejects an unauthenticated request and leaves the document untouched", async () => {
    const { id } = await makeDoc();
    const r = await run({ documentId: id });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "Unauthorized");
    const [doc] = await q("SELECT status, error_message FROM public.uploaded_question_documents WHERE id = $1", [id]);
    assert.equal(doc.status, "pending");
    assert.equal(doc.error_message, null);
  });

  it("rejects a forged token", async () => {
    const { id } = await makeDoc();
    const r = await run({ documentId: id }, { Authorization: "Bearer not.a.token" });
    assert.equal(r.body.error, "Unauthorized");
  });

  it("submits both PDFs and records the Replit job id", async () => {
    const { id, user } = await makeDoc();
    const r = await run({ documentId: id }, { Authorization: `Bearer ${user.access}` });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.replitJobId, "replit-123");
    assert.deepEqual(stubFields.sort(), ["questions_file", "solutions_file", "use_llm"]);

    const [job] = await q("SELECT id, status, progress_percentage, result_data FROM public.document_processing_jobs WHERE document_id = $1", [id]);
    assert.equal(job.id, r.body.jobId);
    assert.equal(job.status, "running");
    assert.equal(job.progress_percentage, 40);
    assert.equal(job.result_data.replit_job_id, "replit-123");
    const [doc] = await q("SELECT status, current_job_id FROM public.uploaded_question_documents WHERE id = $1", [id]);
    assert.equal(doc.status, "processing");
    assert.equal(doc.current_job_id, job.id);
  });

  it("marks the job and document failed when the document has no file URLs", async () => {
    const { id, user } = await makeDoc({ withFiles: false });
    const r = await run({ documentId: id }, { Authorization: `Bearer ${user.access}` });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "Document not found or missing file URLs");
    const [doc] = await q("SELECT status, error_message FROM public.uploaded_question_documents WHERE id = $1", [id]);
    assert.equal(doc.status, "failed");
    assert.equal(doc.error_message, "Document not found or missing file URLs");
    const [job] = await q("SELECT status, error_message FROM public.document_processing_jobs WHERE document_id = $1", [id]);
    assert.equal(job.status, "failed");
  });

  it("reports an OCR service failure and marks the job failed", async () => {
    const { id, user } = await makeDoc();
    stubReplyStatus = 503;
    try {
      const r = await run({ documentId: id }, { Authorization: `Bearer ${user.access}` });
      assert.equal(r.status, 500);
      assert.match(r.body.error, /Replit service upload failed: 503 - service down/);
    } finally {
      stubReplyStatus = 200;
    }
    const [job] = await q("SELECT status FROM public.document_processing_jobs WHERE document_id = $1", [id]);
    assert.equal(job.status, "failed");
  });
});
