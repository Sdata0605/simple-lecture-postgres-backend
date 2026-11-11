import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser } from "./helpers.js";
import { serveRouter, setEnv } from "./router-harness.js";
import { router } from "../functions/bbb-api/index.js";

describe("bbb-api", () => {
  let svc, restore, admin;
  before(async () => {
    await startServer();
    svc = await serveRouter(router);
    restore = setEnv({ SERVICE_KEY: "test-service-key" });
    admin = await makeUser();
  });
  after(async () => {
    restore?.();
    await svc?.close();
    await stopServer();
  });

  it("requires a signed-in user", async () => {
    const r = await svc.post({ action: "info", scheduled_class_id: "x" });
    assert.equal(r.status, 401);
  });

  it("test-connection and create are admin-only", async () => {
    const u = await makeUser();
    const r = await svc.post({ action: "test-connection", server_url: "http://127.0.0.1:1", shared_secret: "s" }, { Authorization: `Bearer ${u.access}` });
    assert.equal(r.status, 403);
    const c = await svc.post({ action: "create", scheduled_class_id: "x" }, { Authorization: `Bearer ${u.access}` });
    assert.equal(c.status, 403);
  });

  it("test-connection validates its inputs", async () => {
    const r = await svc.post({ action: "test-connection" }, { Authorization: "Bearer test-service-key" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /required/);
  });

  it("info without BigBlueButton configured reports an error", async () => {
    const r = await svc.post({ action: "info", scheduled_class_id: "00000000-0000-4000-8000-000000000000" }, { Authorization: `Bearer ${admin.access}` });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /BigBlueButton/);
  });

  it("unknown actions are rejected", async () => {
    const r = await svc.post({ action: "nope" }, { Authorization: `Bearer ${admin.access}` });
    assert.equal(r.status, 400);
  });
});
