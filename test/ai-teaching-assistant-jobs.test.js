import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import express from "express";
import { router, _jobs, _resetJobs } from "../functions/ai-teaching-assistant/index.js";

const ENV_KEYS = ["AI_TEACHING_ASSISTANT_URL", "AI_TEACHING_ASSISTANT_API_KEY", "AI_TEACHING_DEADLINE_MS"];
const HANG = Symbol("hang");
const BASE_PATH = "/functions/v1/ai-teaching-assistant";

let savedEnv;
let stub;
let app;

// Stub upstream. reply(n) gets the 1-based call count and returns { status, body } or HANG.
async function startStub() {
  const s = { calls: 0, lastHeaders: null, lastBody: null, reply: () => ({ status: 200, body: "{}" }) };
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", async () => {
      s.calls += 1;
      s.lastHeaders = req.headers;
      s.lastBody = data;
      const out = await s.reply(s.calls);
      if (out === HANG) return;
      res.writeHead(out.status, { "Content-Type": "application/json" });
      res.end(out.body);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  s.url = `http://127.0.0.1:${server.address().port}/tutor`;
  s.close = () =>
    new Promise((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return s;
}

async function startApp() {
  const a = express();
  a.use(express.json());
  a.use(BASE_PATH, router);
  const server = a.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}${BASE_PATH}`;
  return {
    base,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

async function post(path, obj) {
  const r = await fetch(app.base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  });
  return { status: r.status, body: await r.json() };
}

async function get(path) {
  const r = await fetch(app.base + path);
  return { status: r.status, body: await r.json() };
}

async function pollUntilSettled(jobId, timeoutMs = 10_000) {
  const start = Date.now();
  for (;;) {
    const r = await get(`/jobs/${jobId}`);
    assert.equal(r.status, 200);
    if (r.body.stage === "done" || r.body.stage === "failed") return r.body;
    if (Date.now() - start > timeoutMs) throw new Error(`job ${jobId} did not settle: ${r.body.stage}`);
    await new Promise((res) => setTimeout(res, 30));
  }
}

function setUpstream(url, deadlineMs) {
  process.env.AI_TEACHING_ASSISTANT_URL = url;
  process.env.AI_TEACHING_ASSISTANT_API_KEY = "test-key";
  if (deadlineMs !== undefined) process.env.AI_TEACHING_DEADLINE_MS = String(deadlineMs);
}

before(async () => {
  app = await startApp();
});

after(async () => {
  await app?.close();
});

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  stub = await startStub();
  setUpstream(stub.url);
  _resetJobs();
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  _resetJobs();
  await stub?.close();
});

describe("ai-teaching-assistant POST /", () => {
  it("passes a 200 upstream body through unchanged", async () => {
    stub.reply = () => ({ status: 200, body: JSON.stringify({ answer: "ok" }) });
    const r = await post("/", { question: "What is force?", subjectId: "sub-9" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { answer: "ok" });
    const sent = JSON.parse(stub.lastBody);
    assert.equal(sent.mode, "full");
    assert.equal(sent.question, "What is force?");
    assert.equal(sent.subjectId, "sub-9");
    assert.equal(stub.lastHeaders["x-api-key"], "test-key");
  });

  it("passes a 200 body with an error field through unchanged", async () => {
    stub.reply = () => ({ status: 200, body: JSON.stringify({ error: "subjectId is required" }) });
    const r = await post("/", { question: "What is force?" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { error: "subjectId is required" });
  });

  it("does not retry a 4xx and returns bad_request", async () => {
    stub.reply = () => ({ status: 400, body: JSON.stringify({ detail: "internal upstream detail" }) });
    const r = await post("/", { question: "q" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "bad_request");
    assert.equal(r.body.error.retryable, false);
    assert.equal(r.body.error.message, "We could not send your question. Please try again.");
    assert.equal(JSON.stringify(r.body).includes("internal upstream detail"), false);
    assert.equal(stub.calls, 1);
  });

  it("retries a 503 and succeeds on the second attempt", async () => {
    stub.reply = (n) =>
      n === 1 ? { status: 503, body: "busy" } : { status: 200, body: JSON.stringify({ answer: "ok" }) };
    const r = await post("/", { question: "q" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { answer: "ok" });
    assert.equal(stub.calls, 2);
  });

  it("fails fast with not_configured when the upstream URL is missing", async () => {
    delete process.env.AI_TEACHING_ASSISTANT_URL;
    const started = Date.now();
    const r = await post("/", { question: "q" });
    assert.equal(r.status, 500);
    assert.equal(r.body.error.code, "not_configured");
    assert.equal(r.body.error.retryable, false);
    assert.equal(stub.calls, 0);
    assert.ok(Date.now() - started < 2000);
  });

  it("returns invalid_request when the question is missing", async () => {
    const r = await post("/", { subjectId: "sub-9" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "invalid_request");
    assert.equal(r.body.error.message, "Please type a question first.");
    assert.equal(stub.calls, 0);
  });

  it("gives timeout when the overall deadline passes and the upstream never answers", async () => {
    setUpstream(stub.url, 300);
    stub.reply = () => HANG;
    const started = Date.now();
    const r = await post("/", { question: "q" });
    assert.equal(r.status, 504);
    assert.equal(r.body.error.code, "timeout");
    assert.equal(r.body.error.retryable, true);
    assert.ok(Date.now() - started < 3000);
  });
});

describe("ai-teaching-assistant async jobs", () => {
  it("POST /jobs returns 202 then GET /jobs/:id reaches done with the result", async () => {
    stub.reply = () => new Promise((r) => setTimeout(() => r({ status: 200, body: JSON.stringify({ answer: "42" }) }), 100));
    const created = await post("/jobs", { question: "q", subjectId: "s" });
    assert.equal(created.status, 202);
    assert.equal(typeof created.body.jobId, "string");

    const job = await pollUntilSettled(created.body.jobId);
    assert.equal(job.stage, "done");
    assert.deepEqual(job.result, { answer: "42" });
    assert.equal(job.attempt, 1);
    assert.equal(job.maxAttempts, 3);
    assert.equal(typeof job.elapsedSec, "number");
    assert.equal(typeof job.startedAt, "string");
    assert.equal(typeof job.finishedAt, "string");
    assert.equal("error" in job, false);
  });

  it("a failing job ends in stage failed with error.code", async () => {
    stub.reply = () => ({ status: 400, body: "nope" });
    const created = await post("/jobs", { question: "q" });
    assert.equal(created.status, 202);

    const job = await pollUntilSettled(created.body.jobId);
    assert.equal(job.stage, "failed");
    assert.equal(job.error.code, "bad_request");
    assert.equal(job.error.retryable, false);
    assert.equal(typeof job.error.message, "string");
    assert.equal("result" in job, false);
    assert.equal(stub.calls, 1);
  });

  it("a job with no upstream configured fails immediately with not_configured", async () => {
    delete process.env.AI_TEACHING_ASSISTANT_URL;
    const created = await post("/jobs", { question: "q" });
    assert.equal(created.status, 202);
    const job = await pollUntilSettled(created.body.jobId);
    assert.equal(job.stage, "failed");
    assert.equal(job.error.code, "not_configured");
    assert.equal(stub.calls, 0);
  });

  it("POST /jobs without a question returns 400 and creates no job", async () => {
    const r = await post("/jobs", { subjectId: "s" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "invalid_request");
    assert.equal(_jobs.size, 0);
  });

  it("unknown job id returns 404 job_not_found", async () => {
    const r = await get("/jobs/does-not-exist");
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, {
      error: {
        code: "job_not_found",
        message: "This request has expired. Please ask again.",
        retryable: false,
      },
    });
  });
});
