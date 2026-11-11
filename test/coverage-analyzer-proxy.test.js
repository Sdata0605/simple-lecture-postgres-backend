import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { mountRouter, request, bearer, makeAdmin, stubFetch, uniqueTag } from "./group02-harness.js";
import { router, hooks } from "../functions/coverage-analyzer-proxy/index.js";

describe("coverage-analyzer-proxy", () => {
  let app;
  const saved = process.env.COVERAGE_ANALYZER_BASE_URL;
  const runId = uniqueTag("cov-run");
  let admin;
  before(async () => {
    process.env.COVERAGE_ANALYZER_BASE_URL = "http://analyzer.test:7860";
    await startServer();
    app = await mountRouter("/functions/v1/coverage-analyzer-proxy", router);
    admin = await makeAdmin();
  });
  after(async () => {
    hooks.fetch = null;
    if (saved === undefined) delete process.env.COVERAGE_ANALYZER_BASE_URL;
    else process.env.COVERAGE_ANALYZER_BASE_URL = saved;
    await q("DELETE FROM public.coverage_analyzer_reports WHERE run_id = $1", [runId]);
    await q("DELETE FROM public.user_roles WHERE user_id = $1", [admin.id]);
    await app.close();
    await stopServer();
  });

  it("requires a bearer token", async () => {
    const r = await request(`${app.base}/api/health`, { method: "GET" });
    assert.equal(r.status, 401);
  });

  it("rejects a signed-in user who is not an admin", async () => {
    const u = await makeUser();
    const r = await request(`${app.base}/api/health`, { method: "GET", headers: bearer(u.access) });
    assert.equal(r.status, 403);
  });

  it("forwards the root path to the health endpoint for an admin", async () => {
    hooks.fetch = stubFetch(200, { ok: true });
    const r = await request(app.base, { method: "GET", headers: bearer(admin.access) });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assert.equal(hooks.fetch.calls[0].url, "http://analyzer.test:7860/api/health");
  });

  it("stores a new run on POST /api/analyze and finishes it on a terminal poll", async () => {
    hooks.fetch = stubFetch(200, { run_id: runId, status: "started" });
    const start = await request(`${app.base}/api/analyze`, {
      body: { type: "phy", action: "publish", job_ids: ["j1", "j2"] },
      headers: bearer(admin.access),
    });
    assert.equal(start.status, 200);
    const [row] = await q("SELECT status, subject_prefix, job_id FROM public.coverage_analyzer_reports WHERE run_id = $1", [runId]);
    assert.equal(row.status, "started");
    assert.equal(row.subject_prefix, "phy");
    assert.equal(row.job_id, "j1,j2");

    hooks.fetch = stubFetch(200, {
      status: "done",
      results: [{ coverage: { coverage_percent: 80, topics_missing: ["t9"] } }],
      jobs: ["j1"],
      finished_at: new Date().toISOString(),
    });
    const poll = await request(`${app.base}/api/analyze/${runId}`, { method: "GET", headers: bearer(admin.access) });
    assert.equal(poll.status, 200);
    const [done] = await q("SELECT status, coverage_percent, job_id FROM public.coverage_analyzer_reports WHERE run_id = $1", [runId]);
    assert.equal(done.status, "done");
    assert.equal(Number(done.coverage_percent), 80);
    assert.equal(done.job_id, "j1");
  });
});
