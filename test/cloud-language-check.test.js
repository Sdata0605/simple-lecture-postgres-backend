import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer } from "./helpers.js";
import { mountRouter, request, stubFetch } from "./group02-harness.js";
import { router, hooks } from "../functions/cloud-language-check/index.js";

describe("cloud-language-check", () => {
  let app;
  const savedUrl = process.env.CLOUD_LANGUAGE_CHECK_URL;
  before(async () => {
    await startServer();
    app = await mountRouter("/functions/v1/cloud-language-check", router);
  });
  after(async () => {
    hooks.fetch = null;
    if (savedUrl === undefined) delete process.env.CLOUD_LANGUAGE_CHECK_URL;
    else process.env.CLOUD_LANGUAGE_CHECK_URL = savedUrl;
    await app.close();
    await stopServer();
  });

  it("rejects a request without jobs", async () => {
    const r = await request(app.base, { body: {} });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /jobs/);
  });

  it("ignores non-string jobs and rejects when none are left", async () => {
    const r = await request(app.base, { body: { jobs: [1, null, ""] } });
    assert.equal(r.status, 400);
  });

  it("returns 200 with an error when the checker URL is not configured", async () => {
    delete process.env.CLOUD_LANGUAGE_CHECK_URL;
    const r = await request(app.base, { body: { jobs: ["abc"] } });
    assert.equal(r.status, 200);
    assert.match(r.body.error, /not configured/);
    assert.deepEqual(r.body.results, []);
  });

  it("forwards the string jobs to the configured checker and returns its payload", async () => {
    process.env.CLOUD_LANGUAGE_CHECK_URL = "http://checker.test/api/check";
    hooks.fetch = stubFetch(200, { results: [{ job: "a", ok: true }] });
    const r = await request(app.base, { body: { jobs: ["a", 5, "b"] } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.results, [{ job: "a", ok: true }]);
    const call = hooks.fetch.calls[0];
    assert.equal(call.url, "http://checker.test/api/check");
    assert.deepEqual(JSON.parse(call.init.body), { jobs: ["a", "b"] });
  });

  it("turns an upstream failure into a 200 error body", async () => {
    process.env.CLOUD_LANGUAGE_CHECK_URL = "http://checker.test/api/check";
    hooks.fetch = stubFetch(500, { detail: "down" });
    const r = await request(app.base, { body: { jobs: ["a"] } });
    assert.equal(r.status, 200);
    assert.equal(r.body.error, "Upstream failed");
    assert.equal(r.body.upstream_status, 500);
    assert.deepEqual(r.body.results, []);
  });
});
