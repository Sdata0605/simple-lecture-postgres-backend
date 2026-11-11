import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer } from "./helpers.js";
import { serveRouter, startUpstream, setEnv } from "./router-harness.js";
import { router } from "../functions/ai-text-answer-proxy/index.js";

describe("ai-text-answer-proxy", () => {
  let svc, up, restore;
  before(async () => {
    await startServer();
    svc = await serveRouter(router);
    up = await startUpstream((req, body) => {
      const sent = JSON.parse(body.toString());
      if (sent.question === "missing") return { status: 404, body: JSON.stringify({ error: "no_content" }) };
      return { status: 200, body: JSON.stringify({ answer: "stub", subjectId: sent.subjectId }) };
    });
    restore = setEnv({ AI_TEXT_ANSWER_URL: `${up.base}/ai-text-answer`, AI_TEXT_ANSWER_API_KEY: "test-api-key" });
  });
  after(async () => {
    restore?.();
    await svc?.close();
    await up?.close();
    await stopServer();
  });

  it("only accepts POST", async () => {
    const r = await svc.get("");
    assert.equal(r.status, 405);
  });

  it("requires question and subjectId", async () => {
    const r = await svc.post({ question: "", subjectId: "s" });
    assert.equal(r.status, 400);
  });

  it("works without an API key (the upstream answers without one) and sends no key header", async () => {
    const off = setEnv({ AI_TEXT_ANSWER_API_KEY: undefined });
    try {
      const r = await svc.post({ question: "q", subjectId: "s" });
      assert.equal(r.status, 200);
      const last = up.seen[up.seen.length - 1];
      assert.equal(last.headers["x-api-key"], undefined);
    } finally {
      off();
    }
  });

  it("forwards to the upstream with the key header and keeps the upstream status", async () => {
    const ok = await svc.post({ question: "q", subjectId: "sub-1" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.answer, "stub");
    const last = up.seen[up.seen.length - 1];
    assert.equal(last.headers["x-api-key"], "test-api-key");

    const miss = await svc.post({ question: "missing", subjectId: "sub-1" });
    assert.equal(miss.status, 404);
  });
});
