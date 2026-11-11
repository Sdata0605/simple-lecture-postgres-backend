import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer } from "./helpers.js";
import { serveRouter, setEnv } from "./router-harness.js";
import { router } from "../functions/auto-publish-story-reels/index.js";

// Only the authorisation path is tested here: a full run would call the reel servers on the reel_jobs rows.
describe("auto-publish-story-reels", () => {
  let svc, restore;
  before(async () => {
    await startServer();
    svc = await serveRouter(router);
    restore = setEnv({ SERVICE_KEY: "test-service-key" });
  });
  after(async () => {
    restore?.();
    await svc?.close();
    await stopServer();
  });

  it("refuses callers without the service key", async () => {
    const r = await svc.post({});
    assert.equal(r.status, 401);
    const wrong = await svc.post({}, { Authorization: "Bearer nope" });
    assert.equal(wrong.status, 401);
  });
});
