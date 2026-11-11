import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, q } from "./helpers.js";
import { mountRouter, request, uniqueTag } from "./group02-harness.js";
import { router, hooks } from "../functions/cdn-presentation-refresh-worker/index.js";

const CRON = "cdn-cron-test-key-0123456789";

describe("cdn-presentation-refresh-worker", () => {
  let app;
  const tag = uniqueTag("cdnworker");
  const okExt = `ok-${Math.random().toString(36).slice(2, 9)}`;
  const missExt = `miss-${Math.random().toString(36).slice(2, 9)}`;
  const videoId = `cw-${Math.random().toString(36).slice(2, 7)}`; // varchar(9)
  const saved = { key: process.env.CDN_REFRESH_CRON_KEY, host: process.env.CDN_RENDER_HOST };
  let subjectId;
  let runIds = [];
  before(async () => {
    process.env.CDN_REFRESH_CRON_KEY = CRON;
    process.env.CDN_RENDER_HOST = "http://cdn.test";
    await startServer();
    app = await mountRouter("/functions/v1/cdn-presentation-refresh-worker", router);
    [{ subject_id: subjectId }] = await q("SELECT subject_id FROM public.subject_chapters WHERE subject_id IS NOT NULL LIMIT 1");
    await q(
      "INSERT INTO public.video_generation_jobs (id, subject_id, status, external_job_id) VALUES ($1, $2, 'completed', $3)",
      [videoId, subjectId, okExt]
    );
  });
  after(async () => {
    try {
      hooks.fetch = null;
      for (const id of runIds) await q("DELETE FROM public.cdn_presentation_refresh_runs WHERE id = $1", [id]);
      await q("DELETE FROM public.video_generation_jobs WHERE id = $1", [videoId]);
    } finally {
      for (const [k, env] of [["CDN_REFRESH_CRON_KEY", saved.key], ["CDN_RENDER_HOST", saved.host]]) {
        if (env === undefined) delete process.env[k];
        else process.env[k] = env;
      }
      await app.close();
      await stopServer();
    }
  });

  // Inserts a run that is old enough not to be soft-locked. Returns its id.
  async function insertRun(jobs) {
    const [{ id }] = await q(
      `INSERT INTO public.cdn_presentation_refresh_runs (status, job_queue, total_jobs, label, updated_at)
       VALUES ('processing', $1::jsonb, $2, $3, now() - interval '10 minutes') RETURNING id`,
      [JSON.stringify(jobs), jobs.length, tag]
    );
    runIds.push(id);
    return id;
  }

  it("requires the cron key", async () => {
    assert.equal((await request(app.base, { body: {} })).status, 401);
    assert.equal((await request(app.base, { body: {}, headers: { "x-cron-key": "wrong" } })).status, 401);
  });

  it("marks missing presentation files as skipped and processes present ones", async () => {
    hooks.fetch = async (url) => {
      if (url.includes(okExt)) {
        return new Response(JSON.stringify({ sections: [{ id: "s1" }] }), { status: 200 });
      }
      return new Response("", { status: 404 });
    };
    const runId = await insertRun([
      { video_job_id: videoId, external_job_id: okExt, status: "pending", error_message: null },
      { video_job_id: "nope-missing", external_job_id: missExt, status: "pending", error_message: null },
    ]);

    const r = await request(app.base, { body: {}, headers: { "x-cron-key": CRON } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);

    const [run] = await q("SELECT status, completed_jobs, skipped_jobs, job_queue FROM public.cdn_presentation_refresh_runs WHERE id = $1", [runId]);
    assert.equal(run.status, "completed");
    assert.equal(run.completed_jobs, 1);
    assert.equal(run.skipped_jobs, 1);
    assert.equal(run.job_queue[0].status, "completed");
    assert.equal(run.job_queue[1].status, "skipped");
    assert.equal(run.job_queue[1].error_message, "http_404 (missing on CDN)");

    const [vj] = await q("SELECT presentation_json FROM public.video_generation_jobs WHERE id = $1", [videoId]);
    assert.equal(vj.presentation_json.sections[0].id, "s1");
  });
});
