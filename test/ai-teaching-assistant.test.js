import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer } from "./helpers.js";
import { serveRouter, startUpstream, setEnv } from "./router-harness.js";
import { router } from "../functions/ai-teaching-assistant/index.js";

describe("ai-teaching-assistant", () => {
  let svc, up, restore;
  before(async () => {
    await startServer();
    svc = await serveRouter(router);
    up = await startUpstream(() => ({ status: 200, body: JSON.stringify({ answer: "ok" }) }));
    restore = setEnv({ AI_TEACHING_ASSISTANT_URL: `${up.base}/ai-teaching-assistant`, AI_TEACHING_ASSISTANT_API_KEY: "test-key" });
  });
  after(async () => {
    restore?.();
    await svc?.close();
    await up?.close();
    await stopServer();
  });

  it("maps client fields onto the upstream contract", async () => {
    const r = await svc.post({ question: "What is force?", subjectId: "sub-9" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { answer: "ok" });
    const last = up.seen[up.seen.length - 1];
    const sent = JSON.parse(last.body.toString());
    assert.equal(sent.mode, "full");
    assert.equal(sent.question, "What is force?");
    assert.equal(sent.subjectId, "sub-9");
    assert.equal(sent.userTier, "pro");
    assert.equal(last.headers["x-api-key"], "test-key");
  });

  it("returns 500 when the upstream URL is not configured", async () => {
    const off = setEnv({ AI_TEACHING_ASSISTANT_URL: undefined });
    try {
      const r = await svc.post({ question: "q" });
      assert.equal(r.status, 500);
    } finally {
      off();
    }
  });
});
