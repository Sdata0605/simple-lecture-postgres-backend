import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer } from "./helpers.js";
import { serveRouter } from "./router-harness.js";
import { router } from "../functions/analyze-document-structure/index.js";

// Only the paths that never reach an AI provider are tested here. The ai_settings row is not changed,
// so with no enabled provider the function answers AI_NOT_CONFIGURED without calling anything.
describe("analyze-document-structure", () => {
  let svc;
  before(async () => {
    await startServer();
    svc = await serveRouter(router);
  });
  after(async () => {
    await svc?.close();
    await stopServer();
  });

  it("rejects missing or short content", async () => {
    const r = await svc.post({ contentMarkdown: "too short" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { success: false, error: "No valid content provided for analysis", errorCode: "NO_CONTENT" });
  });

  it("accepts JSON content as the source text", async () => {
    const r = await svc.post({ contentJson: { q: "x".repeat(10) } });
    assert.equal(r.body.errorCode, "NO_CONTENT");
  });
});
