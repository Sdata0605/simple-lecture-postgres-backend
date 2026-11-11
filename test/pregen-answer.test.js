import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { startServer, stopServer, q } from "./helpers.js";
import { router } from "../functions/pregen-answer/index.js";

// The CPU teaching assistant is replaced by a local stub. No real host is contacted.
let stub;
let stubBase;
let stubMode = "valid"; // valid | blocked | http500
let stubCalls = 0;
let lastKey;
let fnServer;
let fnBase;
const savedEnv = {};
const ENV_KEYS = ["AI_TEACHING_CPU_BASE", "AI_TEACHING_CPU_API_KEY"];
const questionIds = [];

const validAnswer = (tag) => ({
  presentationSlides: [{ title: `slide ${tag}` }],
  explanation: `answer ${tag}`,
});

async function call(method, body, headers = {}) {
  const res = await fetch(fnBase + "/", {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

const newQid = () => {
  const id = "pq-" + randomUUID();
  questionIds.push(id);
  return id;
};

describe("pregen-answer", () => {
  before(async () => {
    await startServer();
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

    stub = http.createServer((req, res) => {
      stubCalls++;
      lastKey = req.headers["x-api-key"];
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const q = JSON.parse(raw || "{}");
        if (stubMode === "http500") {
          res.writeHead(500, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "cpu exploded" }));
        }
        const data = stubMode === "blocked"
          ? { blocked: true, presentationSlides: [{ title: "x" }] }
          : { ...validAnswer(q.question), subjectName: q.subjectName };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      });
    });
    stub.listen(0, "127.0.0.1");
    await once(stub, "listening");
    stubBase = `http://127.0.0.1:${stub.address().port}`;

    process.env.AI_TEACHING_CPU_BASE = stubBase;
    process.env.AI_TEACHING_CPU_API_KEY = "test-cpu-key";

    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/", router);
    fnServer = app.listen(0, "127.0.0.1");
    await once(fnServer, "listening");
    fnBase = `http://127.0.0.1:${fnServer.address().port}`;
  });

  after(async () => {
    if (questionIds.length) await q("DELETE FROM public.pregen_question_cache WHERE question_id = ANY($1)", [questionIds]);
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await new Promise((r) => fnServer.close(r));
    await new Promise((r) => stub.close(r));
    await stopServer();
  });

  it("answers OPTIONS", async () => {
    const r = await call("OPTIONS");
    assert.equal(r.status, 200);
  });

  it("rejects non-POST methods with 405", async () => {
    const r = await call("GET");
    assert.equal(r.status, 405);
    assert.equal(r.body.error, "Method not allowed");
  });

  it("requires questionId and questionText", async () => {
    const r = await call("POST", { questionId: "x" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "questionId and questionText are required");
  });

  it("misses the cache, asks the CPU, and stores the valid answer", async () => {
    const qid = newQid();
    const before = stubCalls;
    const r = await call("POST", { questionId: qid, questionText: "What is 2+2?", subjectId: "s-1", subjectName: "Maths" });
    assert.equal(r.status, 200);
    assert.equal(r.body.source, "cpu");
    assert.equal(r.body.data.subjectName, "Maths");
    assert.equal(stubCalls, before + 1);
    assert.equal(lastKey, "test-cpu-key");
    const [row] = await q("SELECT response_json, subject_id FROM public.pregen_question_cache WHERE question_id = $1", [qid]);
    assert.equal(row.response_json.explanation, "answer What is 2+2?");
    assert.equal(row.subject_id, "s-1");
  });

  it("serves a second request from the cache without calling the CPU", async () => {
    const qid = newQid();
    await call("POST", { questionId: qid, questionText: "Cached question" });
    const before = stubCalls;
    const r = await call("POST", { questionId: qid, questionText: "Cached question" });
    assert.equal(r.status, 200);
    assert.equal(r.body.source, "cache");
    assert.equal(r.body.data.explanation, "answer Cached question");
    assert.equal(stubCalls, before);
  });

  it("ignores a stale non-answer cache row and asks the CPU again", async () => {
    const qid = newQid();
    await q(
      "INSERT INTO public.pregen_question_cache (question_id, question_text, response_json) VALUES ($1, 'old', $2::jsonb)",
      [qid, JSON.stringify({ blocked: true, presentationSlides: [{ t: 1 }] })]
    );
    const r = await call("POST", { questionId: qid, questionText: "Fresh question" });
    assert.equal(r.body.source, "cpu");
  });

  it("does not cache a blocked answer", async () => {
    const qid = newQid();
    stubMode = "blocked";
    try {
      const r = await call("POST", { questionId: qid, questionText: "Blocked question" });
      assert.equal(r.status, 200);
      assert.equal(r.body.source, "cpu");
      assert.equal(r.body.data.blocked, true);
    } finally {
      stubMode = "valid";
    }
    const rows = await q("SELECT 1 FROM public.pregen_question_cache WHERE question_id = $1", [qid]);
    assert.equal(rows.length, 0);
  });

  it("passes a CPU HTTP failure through as 502", async () => {
    const qid = newQid();
    stubMode = "http500";
    try {
      const r = await call("POST", { questionId: qid, questionText: "Broken question" });
      assert.equal(r.status, 502);
      assert.equal(r.body.error, "cpu exploded");
    } finally {
      stubMode = "valid";
    }
  });
});
