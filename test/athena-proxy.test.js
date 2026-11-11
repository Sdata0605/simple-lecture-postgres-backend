import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer } from "./helpers.js";
import { serveRouter, startUpstream, setEnv } from "./router-harness.js";
import { router } from "../functions/athena-proxy/index.js";

describe("athena-proxy", () => {
  let svc, up, restore;
  before(async () => {
    await startServer();
    svc = await serveRouter(router);
    up = await startUpstream((req) => ({ status: 200, body: JSON.stringify({ upstreamPath: req.url }) }));
    restore = setEnv({ ATHENA_BASE_URL: up.base, ATHENA_ALLOWED_BASES: undefined });
  });
  after(async () => {
    restore?.();
    await svc?.close();
    await up?.close();
    await stopServer();
  });

  it("rejects an invalid path", async () => {
    const r = await svc.get("?path=/a%20b");
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "Invalid path");
  });

  it("rejects a non-http base and a base that is not allowed", async () => {
    assert.equal((await svc.get("?path=/x&base=ftp://files.test")).body.error, "Invalid base URL");
    const r = await svc.get("?path=/x&base=http://elsewhere.test:9");
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "Base URL not allowed");
  });

  it("forwards a GET to the configured base, keeping extra query params", async () => {
    const r = await svc.get("?path=/subjects?a=1&b=2");
    assert.equal(r.status, 200);
    assert.equal(r.body.upstreamPath, "/subjects?a=1&b=2");
  });

  it("returns 500 when no base is configured", async () => {
    const off = setEnv({ ATHENA_BASE_URL: undefined });
    try {
      const r = await svc.get("?path=/subjects");
      assert.equal(r.status, 500);
    } finally {
      off();
    }
  });
});
