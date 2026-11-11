import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { serveRouter, setEnv } from "./router-harness.js";
import { router } from "../functions/auto-pipeline-scanner/index.js";

describe("auto-pipeline-scanner", () => {
  let svc, restore, admin;
  before(async () => {
    await startServer();
    svc = await serveRouter(router);
    restore = setEnv({ SERVICE_KEY: "test-service-key" });
    admin = await makeUser();
    await q("INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')", [admin.id]);
  });
  after(async () => {
    await q("DELETE FROM public.user_roles WHERE user_id = $1", [admin.id]);
    restore?.();
    await svc?.close();
    await stopServer();
  });

  it("requires an admin token or the service key", async () => {
    const r = await svc.post({ action: "init" });
    assert.equal(r.status, 401);
    const u = await makeUser();
    const r2 = await svc.post({ action: "init" }, { Authorization: `Bearer ${u.access}` });
    assert.equal(r2.status, 401);
  });

  it("init validates its fields", async () => {
    const r = await svc.post({ action: "init", subject_id: "x" }, { Authorization: "Bearer test-service-key" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "Missing required fields");
  });

  it("init with unknown chapters returns 400", async () => {
    const r = await svc.post(
      { action: "init", subject_id: "00000000-0000-4000-8000-000000000001", subject_name: "Test", chapter_ids: ["00000000-0000-4000-8000-000000000002"] },
      { Authorization: `Bearer ${admin.access}` }
    );
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "No chapters found");
  });

  it("scan_chapter for an unknown run returns 404, and unknown actions 400", async () => {
    const r = await svc.post(
      { action: "scan_chapter", run_id: "00000000-0000-4000-8000-000000000003", chapter_id: "00000000-0000-4000-8000-000000000002", subject_id: "00000000-0000-4000-8000-000000000001" },
      { Authorization: "Bearer test-service-key" }
    );
    assert.equal(r.status, 404);
    const bad = await svc.post({ action: "legacy" }, { Authorization: "Bearer test-service-key" });
    assert.equal(bad.status, 400);
    const none = await svc.post({}, { Authorization: "Bearer test-service-key" });
    assert.equal(bad.status, 400);
  });
});
