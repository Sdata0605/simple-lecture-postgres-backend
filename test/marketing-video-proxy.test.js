import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser } from "./helpers.js";
import { serveRouter, hitAt } from "./route-harness.js";
import { router, hooks, normalizeTargetLanguages, normalizeB2Path, getMimeType } from "../functions/marketing-video-proxy/index.js";

describe("marketing-video-proxy", () => {
  let r;
  let user;
  const saved = { host: process.env.MARKETING_VIDEO_HOST, svc: process.env.SERVICE_KEY };
  const realFetch = hooks.fetch;
  before(async () => {
    await startServer();
    r = await serveRouter("/functions/v1/marketing-video-proxy", router);
    user = await makeUser();
    process.env.SERVICE_KEY = "test-service-key-not-real";
  });
  after(async () => {
    hooks.fetch = realFetch;
    for (const [k, envName] of [["host", "MARKETING_VIDEO_HOST"], ["svc", "SERVICE_KEY"]]) {
      if (saved[k] === undefined) delete process.env[envName];
      else process.env[envName] = saved[k];
    }
    await r.close();
    await stopServer();
  });
  const auth = () => ({ Authorization: `Bearer ${user.access}` });

  it("requires a token", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/marketing-video-proxy", { body: { action: "status", job_id: "j" } });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: "Missing token" });
  });

  it("rejects a bad token", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/marketing-video-proxy", {
      body: { action: "status", job_id: "j" },
      headers: { Authorization: "Bearer nope" },
    });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: "Invalid token" });
  });

  it("returns 500 when the pipeline host is not configured", async () => {
    delete process.env.MARKETING_VIDEO_HOST;
    const res = await hitAt(r.base, "POST", "/functions/v1/marketing-video-proxy", {
      body: { action: "status", job_id: "j" },
      headers: auth(),
    });
    assert.equal(res.status, 500);
    assert.match(res.body.error, /MARKETING_VIDEO_HOST/);
  });

  it("refuses a server_ip other than the configured host", async () => {
    process.env.MARKETING_VIDEO_HOST = "pipeline.example.test";
    const res = await hitAt(r.base, "POST", "/functions/v1/marketing-video-proxy", {
      body: { action: "status", job_id: "j", server_ip: "10.0.0.9" },
      headers: auth(),
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "server_ip is not allowed");
  });

  it("requires job_id for status and rejects unknown actions", async () => {
    process.env.MARKETING_VIDEO_HOST = "pipeline.example.test";
    const a = await hitAt(r.base, "POST", "/functions/v1/marketing-video-proxy", { body: { action: "status" }, headers: auth() });
    assert.equal(a.status, 400);
    assert.deepEqual(a.body, { error: "job_id required" });
    const b = await hitAt(r.base, "POST", "/functions/v1/marketing-video-proxy", { body: { action: "delete" }, headers: auth() });
    assert.equal(b.status, 400);
    assert.equal(b.body.error, "Unsupported action: delete");
  });

  it("requires document_url or markdown for submit", async () => {
    process.env.MARKETING_VIDEO_HOST = "pipeline.example.test";
    const res = await hitAt(r.base, "POST", "/functions/v1/marketing-video-proxy", { body: { action: "submit" }, headers: auth() });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "document_url or markdown required" });
  });

  it("forwards status to the pipeline with the player URL added (stubbed)", async () => {
    process.env.MARKETING_VIDEO_HOST = "pipeline.example.test";
    const seen = [];
    hooks.fetch = async (url) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ status: "running" }), { status: 200 });
    };
    const res = await hitAt(r.base, "POST", "/functions/v1/marketing-video-proxy", {
      body: { action: "status", job_id: "abc" },
      headers: { Authorization: `Bearer ${process.env.SERVICE_KEY}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "running");
    assert.match(res.body.player_url, /pipeline\.example\.test:5006\/player_v2\/\?job=abc$/);
    assert.match(seen[0], /\/job\/abc\/status$/);
  });

  it("helpers normalise languages, B2 paths and mime types", () => {
    assert.equal(normalizeTargetLanguages(["hi", "", "en"]), "hi,en");
    assert.equal(normalizeTargetLanguages("null"), null);
    assert.equal(normalizeB2Path("a b/c%20d"), "a%20b/c%20d");
    assert.equal(getMimeType("notes.PDF"), "application/pdf");
    assert.equal(getMimeType("x.unknown"), "application/octet-stream");
  });
});
