import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, q } from "./helpers.js";
import { mountRouter, request, uniqueTag } from "./group02-harness.js";
import { router, hooks } from "../functions/dubbing-batch-tick/index.js";

const CRON = "dubbing-cron-test-key-0123456789";

describe("dubbing-batch-tick", () => {
  let app;
  let subjectId;
  const tag = uniqueTag("dubbing");
  const saved = { cron: process.env.DUBBING_TICK_CRON_KEY, svc: process.env.INTERNAL_SERVICE_KEY, base: process.env.PUBLIC_BASE_URL };
  const runIds = [];
  before(async () => {
    process.env.DUBBING_TICK_CRON_KEY = CRON;
    process.env.INTERNAL_SERVICE_KEY = "svc-dubbing-test-key-0123456789";
    process.env.PUBLIC_BASE_URL = "http://api.test";
    await startServer();
    app = await mountRouter("/functions/v1/dubbing-batch-tick", router);
    [{ subject_id: subjectId }] = await q("SELECT subject_id FROM public.subject_chapters WHERE subject_id IS NOT NULL LIMIT 1");
  });
  after(async () => {
    try {
      hooks.fetch = null;
      for (const id of runIds) await q("DELETE FROM public.auto_submission_runs WHERE id = $1", [id]);
    } finally {
      for (const [k, env] of [
        ["DUBBING_TICK_CRON_KEY", saved.cron],
        ["INTERNAL_SERVICE_KEY", saved.svc],
        ["PUBLIC_BASE_URL", saved.base],
      ]) {
        if (env === undefined) delete process.env[k];
        else process.env[k] = env;
      }
      await app.close();
      await stopServer();
    }
  });

  async function insertRun(items, extra = {}) {
    const [{ id }] = await q(
      `INSERT INTO public.auto_submission_runs
         (subject_id, subject_name, server_ip, status, items, current_index, kind, pipeline_config)
       VALUES ($1, $2, 'test-server', 'running', $3::jsonb, 0, 'dubbing_batch', $4::jsonb) RETURNING id`,
      [subjectId, tag, JSON.stringify(items), JSON.stringify(extra.pipeline_config || { languages: ["hi"] })]
    );
    runIds.push(id);
    return id;
  }

  it("requires the cron key or the service key", async () => {
    assert.equal((await request(app.base, { body: {} })).status, 401);
  });

  it("completes a run whose items are all done and has none left", async () => {
    const id = await insertRun([]);
    const r = await request(app.base, { body: {}, headers: { "x-cron-key": CRON } });
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.processed, "number");
    const [run] = await q("SELECT status FROM public.auto_submission_runs WHERE id = $1", [id]);
    assert.equal(run.status, "completed");
  });

  it("polls a processing item and records the dubbed languages when it completes", async () => {
    const calls = [];
    hooks.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url: String(url), action: body.action, headers: init.headers });
      if (body.action === "dub_status") {
        return new Response(JSON.stringify({ status: "completed", details: { progress: "100%" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ dubbed_languages: [{ lang: "hi", video_path: "p/hi.mp4" }] }), { status: 200 });
    };
    const id = await insertRun([
      { topicId: "t1", topicTitle: "T", videoJobId: "v1", externalJobId: "ext-1", serverIp: "test-server", status: "processing" },
    ]);

    const r = await request(app.base, { body: {}, headers: { "x-cron-key": CRON } });
    assert.equal(r.status, 200);
    assert.ok(calls.some((c) => c.action === "dub_status"));
    assert.ok(calls.every((c) => c.url === "http://api.test/functions/v1/video-generation-proxy"));
    assert.ok(calls.every((c) => c.headers["x-service-key"] === process.env.INTERNAL_SERVICE_KEY));

    const [run] = await q("SELECT status, current_index, items FROM public.auto_submission_runs WHERE id = $1", [id]);
    assert.equal(run.status, "completed");
    assert.equal(run.current_index, 1);
    assert.equal(run.items[0].status, "completed");
    assert.equal(run.items[0].dubbedLanguages[0].lang, "hi");
  });
});
