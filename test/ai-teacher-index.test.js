import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { serveRouter } from "./router-harness.js";
import { router } from "../functions/ai-teacher-index/index.js";

describe("ai-teacher-index", () => {
  let svc, admin;
  before(async () => {
    await startServer();
    svc = await serveRouter(router);
    admin = await makeUser();
    await q("INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')", [admin.id]);
  });
  after(async () => {
    await q("DELETE FROM public.user_roles WHERE user_id = $1", [admin.id]);
    await svc?.close();
    await stopServer();
  });

  const as = (u) => ({ Authorization: `Bearer ${u.access}` });

  it("requires a signed-in user", async () => {
    const r = await svc.post({ action: "coverage" });
    assert.equal(r.status, 401);
  });

  it("refuses non-admins", async () => {
    const u = await makeUser();
    const r = await svc.post({ action: "coverage" }, as(u));
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "Admins only");
  });

  it("admin: coverage returns the subject list", async () => {
    const r = await svc.post({ action: "coverage" }, as(admin));
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.subjects));
  });

  it("admin: index_document for an unknown document is skipped without any API call", async () => {
    const r = await svc.post({ action: "index_document", document_id: "00000000-0000-4000-8000-000000000000" }, as(admin));
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "skipped");
    assert.equal(r.body.reason, "document not found");
  });

  it("admin: rejects a missing id and an unknown action", async () => {
    assert.equal((await svc.post({ action: "index_document" }, as(admin))).status, 400);
    assert.equal((await svc.post({ action: "bogus" }, as(admin))).status, 400);
    assert.equal((await svc.post({ action: "index_subject", subject_id: "nope" }, as(admin))).status, 400);
  });
});
