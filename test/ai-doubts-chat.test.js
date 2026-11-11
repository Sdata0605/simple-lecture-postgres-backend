import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import "./helpers.js";
import { router } from "../functions/ai-doubts-chat/index.js";
import { mountRouter, closeDb } from "./_group00-harness.js";

// A subject with no chapters, documents or questions. The notes are empty, so every question takes the
// refusal path, which is what these tests cover. No AI provider is called.
let app;
let cpuServer;
const subjectId = crypto.randomUUID();
const saved = { base: process.env.AI_TEACHING_CPU_BASE, key: process.env.AI_TEACHING_CPU_KEY };
const ask = (body) => app.post("/", body);

describe("ai-doubts-chat", () => {
  before(async () => {
    app = await mountRouter("/", router);
    delete process.env.AI_TEACHING_CPU_BASE;
    delete process.env.AI_TEACHING_CPU_KEY;
  });
  after(async () => {
    if (cpuServer) await new Promise((r) => cpuServer.close(r));
    if (saved.base === undefined) delete process.env.AI_TEACHING_CPU_BASE;
    else process.env.AI_TEACHING_CPU_BASE = saved.base;
    if (saved.key === undefined) delete process.env.AI_TEACHING_CPU_KEY;
    else process.env.AI_TEACHING_CPU_KEY = saved.key;
    await app.close();
    await closeDb();
  });

  it("requires question and subjectId", async () => {
    const r = await ask({ question: "What is light?" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "Missing required fields: question and subjectId");
  });

  it("with no notes, refuses with notFound and calls no AI", async () => {
    const r = await ask({ question: "Explain photosynthesis in plants", subjectId });
    assert.equal(r.status, 200);
    assert.equal(r.body.notFound, true);
    assert.deepEqual(r.body.suggestions, []);
    assert.deepEqual(r.body.sources, []);
    assert.match(r.body.answer, /doesn't seem to be part of your current syllabus/);
  });

  it("a non-uuid subject is treated as having no notes", async () => {
    const r = await ask({ question: "Explain photosynthesis in plants", subjectId: "not-a-uuid" });
    assert.equal(r.status, 200);
    assert.equal(r.body.notFound, true);
  });

  it("when no notes match, uses the general-AI service if configured (local stub)", async () => {
    cpuServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const ok = req.headers["x-api-key"] === "stub-key-not-real" && req.url === "/ai-teaching-assistant";
        res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
        res.end(JSON.stringify(ok ? { answer: "General answer from stub." } : { error: "bad key" }));
      });
    });
    cpuServer.listen(0, "127.0.0.1");
    await once(cpuServer, "listening");
    process.env.AI_TEACHING_CPU_BASE = `http://127.0.0.1:${cpuServer.address().port}`;
    process.env.AI_TEACHING_CPU_KEY = "stub-key-not-real";
    const r = await ask({ question: "Explain photosynthesis in plants", subjectId });
    assert.equal(r.status, 200);
    assert.equal(r.body.answer, "General answer from stub.");
    assert.equal(r.body.fromGeneralAI, true);
    delete process.env.AI_TEACHING_CPU_BASE;
    delete process.env.AI_TEACHING_CPU_KEY;
  });
});
