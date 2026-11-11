import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer } from "./helpers.js";
import { serveRouter, startUpstream, setEnv } from "./router-harness.js";
import { router } from "../functions/ai-teaching-proxy/index.js";

describe("ai-teaching-proxy", () => {
  let svc, up, restore;
  before(async () => {
    await startServer();
    svc = await serveRouter(router);
    up = await startUpstream((req, body) => ({ status: 200, body: JSON.stringify({ url: req.url, body: body.toString() }) }));
    restore = setEnv({ AI_TEACHING_BASE_URL: up.base, AI_TEACHING_ALLOWED_BASES: undefined });
  });
  after(async () => {
    restore?.();
    await svc?.close();
    await up?.close();
    await stopServer();
  });

  it("rejects paths with dots and disallowed bases", async () => {
    assert.equal((await svc.get("?path=/a.b")).body.error, "Invalid path");
    assert.equal((await svc.get("?path=/x&base=http://other.test:1")).body.error, "Base URL not allowed");
  });

  it("forwards a POST body unchanged", async () => {
    const r = await fetch(`${svc.base}/?path=/questions/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.url, "/questions/import");
    assert.equal(j.body, JSON.stringify({ hello: "world" }));
  });
});
