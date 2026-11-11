import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer } from "./helpers.js";
import { serveRouter, hitAt } from "./route-harness.js";
import { router, hooks } from "../functions/language-generation-worker/index.js";

describe("language-generation-worker", () => {
  let r;
  const savedSvc = process.env.SERVICE_KEY;
  const realFetch = hooks.fetch;
  before(async () => {
    await startServer();
    r = await serveRouter("/functions/v1/language-generation-worker", router);
    process.env.SERVICE_KEY = "test-service-key-not-real";
    // Any render-proxy call during the test gets a failure, so nothing real is reached.
    hooks.fetch = async () => new Response("{}", { status: 500 });
  });
  after(async () => {
    hooks.fetch = realFetch;
    if (savedSvc === undefined) delete process.env.SERVICE_KEY;
    else process.env.SERVICE_KEY = savedSvc;
    await r.close();
    await stopServer();
  });

  it("is closed to callers without the cron key", async () => {
    const none = await hitAt(r.base, "POST", "/functions/v1/language-generation-worker", { body: {} });
    assert.equal(none.status, 401);
    const wrong = await hitAt(r.base, "POST", "/functions/v1/language-generation-worker", {
      body: {},
      headers: { "x-service-key": "wrong-key" },
    });
    assert.equal(wrong.status, 401);
  });

  it("runs a tick with the cron key and answers with a known shape", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/language-generation-worker", {
      body: {},
      headers: { "x-service-key": process.env.SERVICE_KEY },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.success === true || res.body.message === "No active runs");
  });
});
