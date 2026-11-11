import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { startServer, stopServer, q, makeUser } from "./helpers.js";
import { router } from "../functions/process-llm-extraction/index.js";

// The AI provider is replaced by a local stub (AI_OPENAI_URL). No real host is contacted.
let stub;
let stubBase;
let stubReply = { status: 200, body: null };
let fnServer;
let fnBase;
let savedConfigRow; // original ai_api_config row, restored after the tests
let hadConfigRow = false;
const docIds = [];
const jobIds = [];

async function call(method, body) {
  const res = await fetch(fnBase + "/", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

async function setAiConfig(value) {
  await q(
    `INSERT INTO public.ai_settings (setting_key, setting_value) VALUES ('ai_api_config', $1::jsonb)
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`,
    [JSON.stringify(value)]
  );
}

async function makeDocAndJob({ mmd = "\\( x^2 = 4 \\) Q1. Solve." } = {}) {
  const [ref] = await q(
    "SELECT ch.id AS chapter_id, s.id AS subject_id, s.category_id FROM public.subject_chapters ch JOIN public.popular_subjects s ON s.id = ch.subject_id LIMIT 1"
  );
  const uploader = await makeUser();
  const docId = randomUUID();
  docIds.push(docId);
  await q(
    `INSERT INTO public.uploaded_question_documents
       (id, category_id, subject_id, chapter_id, uploaded_by, file_type, file_name, file_url, mathpix_mmd, document_purpose)
     VALUES ($1, $2, $3, $4, $5, 'pdf', 'paper.pdf', 'http://localhost/paper.pdf', $6, 'exam')`,
    [docId, ref.category_id, ref.subject_id, ref.chapter_id, uploader.id, mmd]
  );
  const jobId = randomUUID();
  jobIds.push(jobId);
  await q(
    "INSERT INTO public.document_processing_jobs (id, document_id, job_type, status) VALUES ($1, $2, 'mathpix_processing', 'running')",
    [jobId, docId]
  );
  return { docId, jobId };
}

const openaiConfig = { enabled: true, provider: "openai", openai_api_key: "test-openai-key", default_model: "test-model" };
const twoQuestions = {
  questions: [
    { question_text: "Solve \\( x^2=4 \\)", question_format: "single_choice", options: { A: "2", B: "-2" }, correct_answer: "A", explanation: null, difficulty: "Low", difficulty_reasoning: "simple" },
    { question_text: "Plain question", correct_answer: "text answer", difficulty: "Advanced" },
  ],
};

describe("process-llm-extraction", () => {
  before(async () => {
    await startServer();
    const existing = await q("SELECT setting_value FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    hadConfigRow = existing.length > 0;
    savedConfigRow = hadConfigRow ? existing[0].setting_value : null;

    stub = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(stubReply.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(stubReply.body));
      });
    });
    stub.listen(0, "127.0.0.1");
    await once(stub, "listening");
    stubBase = `http://127.0.0.1:${stub.address().port}`;
    process.env.AI_OPENAI_URL = `${stubBase}/v1/chat/completions`;

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
        await q("DELETE FROM public.questions WHERE source_document_id = ANY($1)", [docIds]);
        await q("DELETE FROM public.parsed_questions_pending WHERE document_id = ANY($1)", [docIds]);
        await q("UPDATE public.uploaded_question_documents SET current_job_id = NULL WHERE id = ANY($1)", [docIds]);
        await q("DELETE FROM public.job_logs WHERE job_id = ANY($1)", [jobIds]);
        await q("DELETE FROM public.document_processing_jobs WHERE id = ANY($1)", [jobIds]);
        await q("DELETE FROM public.uploaded_question_documents WHERE id = ANY($1)", [docIds]);
      }
      if (hadConfigRow) await setAiConfig(savedConfigRow);
      else await q("DELETE FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    } finally {
      delete process.env.AI_OPENAI_URL;
      await new Promise((r) => fnServer.close(r));
      await new Promise((r) => stub.close(r));
      await stopServer();
    }
  });

  it("answers OPTIONS", async () => {
    const r = await fetch(fnBase + "/", { method: "OPTIONS" });
    assert.equal(r.status, 200);
  });

  it("rejects non-POST methods with 405", async () => {
    const r = await fetch(fnBase + "/", { method: "GET" });
    assert.equal(r.status, 405);
  });

  it("requires jobId and documentId", async () => {
    const r = await call("POST", { jobId: randomUUID() });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "jobId and documentId are required");
  });

  it("fails clearly when no AI provider is configured, and marks the job failed", async () => {
    await setAiConfig({ enabled: false });
    const { docId, jobId } = await makeDocAndJob();
    const r = await call("POST", { jobId, documentId: docId });
    assert.equal(r.status, 500);
    assert.match(r.body.error, /^AI API not configured/);
    const [job] = await q("SELECT status, error_message FROM public.document_processing_jobs WHERE id = $1", [jobId]);
    assert.equal(job.status, "failed");
    assert.match(job.error_message, /AI API not configured/);
  });

  it("fails when the document has no processed content", async () => {
    await setAiConfig(openaiConfig);
    const { docId, jobId } = await makeDocAndJob({ mmd: null });
    await q("UPDATE public.uploaded_question_documents SET mathpix_mmd = NULL WHERE id = $1", [docId]);
    const r = await call("POST", { jobId, documentId: docId });
    assert.equal(r.body.error, "Document has no processed content. Please process document first.");
  });

  it("extracts questions, saves them, and records the difficulty distribution", async () => {
    await setAiConfig(openaiConfig);
    stubReply = { status: 200, body: { choices: [{ message: { content: JSON.stringify(twoQuestions) } }] } };
    const { docId, jobId } = await makeDocAndJob();
    const r = await call("POST", { jobId, documentId: docId });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.questionsExtracted, 2);
    assert.deepEqual(r.body.difficultyDistribution, { Low: 1, Medium: 0, Intermediate: 0, Advanced: 1 });

    const pending = await q("SELECT question_text, question_format, contains_formula, options FROM public.parsed_questions_pending WHERE document_id = $1 ORDER BY question_text", [docId]);
    assert.equal(pending.length, 2);
    const withFormula = pending.find((p) => p.question_text.startsWith("Solve"));
    assert.equal(withFormula.contains_formula, true);
    assert.deepEqual(withFormula.options, { A: "2", B: "-2" });

    const bank = await q("SELECT count(*)::int n FROM public.questions WHERE source_document_id = $1", [docId]);
    assert.equal(bank[0].n, 2);

    const [job] = await q("SELECT status, questions_extracted, progress_percentage, result_data FROM public.document_processing_jobs WHERE id = $1", [jobId]);
    assert.equal(job.status, "completed");
    assert.equal(job.questions_extracted, 2);
    assert.equal(job.progress_percentage, 100);
    assert.equal(job.result_data.total_questions, 2);
  });

  it("accepts a reply wrapped in a markdown code fence", async () => {
    await setAiConfig(openaiConfig);
    stubReply = { status: 200, body: { choices: [{ message: { content: "```json\n" + JSON.stringify({ questions: [] }) + "\n```" } }] } };
    const { docId, jobId } = await makeDocAndJob();
    const r = await call("POST", { jobId, documentId: docId });
    assert.equal(r.status, 200);
    assert.equal(r.body.questionsExtracted, 0);
  });

  it("maps a 429 from the provider to a rate-limit message", async () => {
    await setAiConfig(openaiConfig);
    stubReply = { status: 429, body: { error: "slow down" } };
    const { docId, jobId } = await makeDocAndJob();
    const r = await call("POST", { jobId, documentId: docId });
    assert.equal(r.body.error, "Rate limit exceeded. Please try again later.");
    const [job] = await q("SELECT status FROM public.document_processing_jobs WHERE id = $1", [jobId]);
    assert.equal(job.status, "failed");
  });

  it("maps a 401 from the provider to an API-key message", async () => {
    await setAiConfig(openaiConfig);
    stubReply = { status: 401, body: { error: "bad key" } };
    const { docId, jobId } = await makeDocAndJob();
    const r = await call("POST", { jobId, documentId: docId });
    assert.equal(r.body.error, "Invalid or unauthorized API key. Please check your API key in Admin Settings.");
  });

  it("rejects a reply that is not JSON", async () => {
    await setAiConfig(openaiConfig);
    stubReply = { status: 200, body: { choices: [{ message: { content: "sorry, no json here" } }] } };
    const { docId, jobId } = await makeDocAndJob();
    const r = await call("POST", { jobId, documentId: docId });
    assert.equal(r.body.error, "Failed to parse AI response as JSON");
  });
});
