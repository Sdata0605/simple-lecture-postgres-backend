import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser } from "./helpers.js";
import { serveRouter, setEnv } from "./router-harness.js";
import { router } from "../functions/bulk-auto-assign-chapters/index.js";

describe("bulk-auto-assign-chapters", () => {
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

  it("requires a service key or an admin token", async () => {
    const r = await svc.post({ documentId: "x" });
    assert.equal(r.status, 401);
    const u = await makeUser();
    const r2 = await svc.post({ documentId: "x" }, { Authorization: `Bearer ${u.access}` });
    assert.equal(r2.status, 401);
  });

  it("requires documentId", async () => {
    const r = await svc.post({}, { "x-service-key": "test-service-key" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "documentId is required");
  });
});
