import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser } from "./helpers.js";
import { serveRouter, setEnv } from "./router-harness.js";
import { router } from "../functions/allocate-topic-pyqs/index.js";

describe("allocate-topic-pyqs", () => {
  let svc, restore;
  const ids = { subject_id: "00000000-0000-4000-8000-000000000001", chapter_id: "00000000-0000-4000-8000-000000000002", topic_id: "00000000-0000-4000-8000-000000000003" };
  before(async () => {
    await startServer();
    svc = await serveRouter(router);
    restore = setEnv({ SERVICE_KEY: "test-service-key", NOTES_PIPELINE_INTERNAL_SECRET: "x".repeat(40) });
  });
  after(async () => {
    restore?.();
    await svc?.close();
    await stopServer();
  });

  it("requires an admin or internal caller", async () => {
    const r = await svc.post(ids);
    assert.equal(r.status, 401);
  });

  it("refuses a signed-in non-admin", async () => {
    const u = await makeUser();
    const r = await svc.post(ids, { Authorization: `Bearer ${u.access}` });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "Admin access required");
  });

  it("internal service key is accepted and validates the ids", async () => {
    const missing = await svc.post({ subject_id: "x" }, { Authorization: "Bearer test-service-key" });
    assert.equal(missing.status, 400);
    const unknown = await svc.post(ids, { Authorization: "Bearer test-service-key" });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, "Invalid subject context");
  });

  it("pipeline secret header is accepted", async () => {
    const r = await svc.post(ids, { "x-notes-pipeline-internal": "x".repeat(40) });
    assert.equal(r.status, 404);
  });
});
