import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer } from "./helpers.js";
import { mountRouter, request, stubFetch } from "./group02-harness.js";
import { router, hooks } from "../functions/counselor-avatar-proxy/index.js";

describe("counselor-avatar-proxy", () => {
  let app;
  const saved = process.env.COUNSELOR_AVATAR_BASE_URL;
  before(async () => {
    process.env.COUNSELOR_AVATAR_BASE_URL = "http://avatar.test:5004";
    await startServer();
    app = await mountRouter("/functions/v1/counselor-avatar-proxy", router);
  });
  after(async () => {
    hooks.fetch = null;
    if (saved === undefined) delete process.env.COUNSELOR_AVATAR_BASE_URL;
    else process.env.COUNSELOR_AVATAR_BASE_URL = saved;
    await app.close();
    await stopServer();
  });

  it("rejects a path with characters outside the allowlist", async () => {
    const r = await request(`${app.base}?path=${encodeURIComponent("/api/a.b")}`, { method: "GET" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "Invalid path");
  });

  it("rejects a base URL that is not on the allowlist", async () => {
    const r = await request(`${app.base}?path=/api/health&base=${encodeURIComponent("http://evil.test:5004")}`, { method: "GET" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "Base URL not allowed");
  });

  it("rejects a non-http base URL", async () => {
    const r = await request(`${app.base}?path=/api/health&base=${encodeURIComponent("ftp://avatar.test")}`, { method: "GET" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "Invalid base URL");
  });

  it("forwards a GET to the default base with the extra query parameters", async () => {
    hooks.fetch = stubFetch(200, { status: "ok" });
    const r = await request(`${app.base}?path=${encodeURIComponent("/api/health?v=2")}&extra=1`, { method: "GET" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { status: "ok" });
    assert.equal(hooks.fetch.calls[0].url, "http://avatar.test:5004/api/health?v=2&extra=1");
  });

  it("passes a 4xx from the avatar server straight back", async () => {
    hooks.fetch = stubFetch(404, { error: "no such job" });
    const r = await request(`${app.base}?path=/api/status/x`, { method: "GET" });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "no such job");
  });

  it("forwards multipart uploads as the original bytes", async () => {
    hooks.fetch = stubFetch(200, { uploaded: true });
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x0d, 0x0a]);
    const r = await request(`${app.base}?path=/api/library/upload`, {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=xyz" },
      raw: bytes,
    });
    assert.equal(r.status, 200);
    const sent = hooks.fetch.calls[0].init.body;
    assert.ok(Buffer.from(sent).equals(bytes));
  });
});
