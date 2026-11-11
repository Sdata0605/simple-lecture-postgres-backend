import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { mountRouter, request, bearer, makeAdmin, uniqueTag } from "./group02-harness.js";
import { router } from "../functions/cdn-presentation-refresh-start/index.js";

describe("cdn-presentation-refresh-start", () => {
  let app;
  let admin;
  let subjectId;
  const tag = uniqueTag("cdnstart");
  const externalId = `ext-${Math.random().toString(36).slice(2, 10)}`;
  const videoId = `cs-${Math.random().toString(36).slice(2, 7)}`; // varchar(9)
  let runId;
  before(async () => {
    await startServer();
    app = await mountRouter("/functions/v1/cdn-presentation-refresh-start", router);
    admin = await makeAdmin();
    [{ subject_id: subjectId }] = await q("SELECT subject_id FROM public.subject_chapters WHERE subject_id IS NOT NULL LIMIT 1");
  });
  after(async () => {
    try {
      if (runId) await q("DELETE FROM public.cdn_presentation_refresh_runs WHERE id = $1", [runId]);
      await q("DELETE FROM public.video_generation_jobs WHERE id = $1", [videoId]);
      await q("DELETE FROM public.user_roles WHERE user_id = $1", [admin.id]);
    } finally {
      await app.close();
      await stopServer();
    }
  });

  it("accepts only POST", async () => {
    const r = await request(app.base, { method: "GET", headers: bearer(admin.access) });
    assert.equal(r.status, 405);
  });

  it("requires a token", async () => {
    const r = await request(app.base, { body: {} });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "missing auth");
  });

  it("rejects an invalid token", async () => {
    const r = await request(app.base, { body: {}, headers: { Authorization: "Bearer not-a-jwt" } });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "unauthorized");
  });

  it("rejects a signed-in user who is not an admin", async () => {
    const u = await makeUser();
    const r = await request(app.base, { body: {}, headers: bearer(u.access) });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "not admin");
  });

  it("returns 404 for an external_job_id that is not known", async () => {
    const r = await request(app.base, { body: { external_job_id: "nope-" + tag }, headers: bearer(admin.access) });
    assert.equal(r.status, 404);
  });

  it("queues one job in single-job mode", async () => {
    await q(
      "INSERT INTO public.video_generation_jobs (id, subject_id, status, external_job_id) VALUES ($1, $2, 'completed', $3)",
      [videoId, subjectId, externalId]
    );
    const r = await request(app.base, { body: { external_job_id: externalId }, headers: bearer(admin.access) });
    assert.equal(r.status, 200);
    assert.equal(r.body.queued, 1);
    runId = r.body.run_id;
    const [run] = await q("SELECT status, total_jobs, label, job_queue, created_by FROM public.cdn_presentation_refresh_runs WHERE id = $1", [runId]);
    assert.equal(run.status, "processing");
    assert.equal(run.total_jobs, 1);
    assert.equal(run.created_by, admin.id);
    assert.equal(run.job_queue[0].external_job_id, externalId);
    assert.equal(run.job_queue[0].video_job_id, videoId);
  });
});
