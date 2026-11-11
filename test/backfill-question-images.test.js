import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer } from "./helpers.js";
import { serveRouter, setEnv } from "./router-harness.js";
import { router } from "../functions/backfill-question-images/index.js";

describe("backfill-question-images", () => {
  let svc, restore;
  before(async () => {
    await startServer();
    svc = await serveRouter(router);
    restore = setEnv({ SERVICE_KEY: "test-service-key", PUBLIC_BASE_URL: "http://127.0.0.1:1" });
  });
  after(async () => {
    restore?.();
    await svc?.close();
    await stopServer();
  });

  it("refuses callers without the service key", async () => {
    const r = await svc.post({});
    assert.equal(r.status, 401);
    const wrong = await fetch(`${svc.base}/`, { method: "POST", headers: { "x-service-key": "nope" } });
    assert.equal(wrong.status, 401);
  });

  it("runs with the service key and reports the batch shape", async () => {
    const r = await fetch(`${svc.base}/`, {
      method: "POST",
      headers: { "x-service-key": "test-service-key", "Content-Type": "application/json" },
      body: JSON.stringify({ offset: 0, limit: 1 }),
    });
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.offset, 0);
    assert.equal(typeof body.totalFolders, "number");
  });
});
