import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { startServer, stopServer, q } from "./helpers.js";
import { router } from "../functions/presentation-update-worker/index.js";

// The video-generation-proxy route is replaced by a local stub (PUBLIC_BASE_URL). No real host is contacted.
const SECRET = "test-cron-secret";
let stub;
let fnServer;
let fnBase;
const savedEnv = {};
const ENV_KEYS = ["CRON_SECRET", "PUBLIC_BASE_URL", "SERVICE_ROLE_KEY"];
const SERVICE = "test-service-role";
const createdRuns = [];
const createdJobs = [];
const proxyCalls = [];

function stubHandler(req, res) {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    proxyCalls.push({ auth: req.headers.authorization, job: body.job_id });
    if (req.url !== "/functions/v1/video-generation-proxy") {
      res.writeHead(404);
      return res.end();
    }
    if (body.job_id === "down-job") {
      res.writeHead(500, { "Content-Type": "text/plain" });
      return res.end("tcp connect error: Connection refused");
    }
    if (body.job_id === "bad-job") {
      res.writeHead(500, { "Content-Type": "text/plain" });
      return res.end("boom: bad review");
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sections: [{ id: 1 }, { id: 2 }] }));
  });
}

async function runWorker(headers = { Authorization: `Bearer ${SECRET}` }) {
  const res = await fetch(fnBase + "/", { method: "POST", headers });
  return { status: res.status, body: await res.json() };
}

// Inserts a run that is not soft-locked, with its own video job rows.
async function makeRun(jobs) {
  const videoIds = [];
  const queue = [];
  for (const j of jobs) {
    const vid = "pv" + Math.random().toString(36).slice(2, 8);
    videoIds.push(vid);
    createdJobs.push(vid);
    await q("INSERT INTO public.video_generation_jobs (id, subject_id) VALUES ($1, $2)", [vid, randomUUID()]);
    queue.push({ video_job_id: vid, external_job_id: j.ext, server_ip: "test-host", status: "pending", error_message: null });
  }
  const id = randomUUID();
  createdRuns.push(id);
  await q(
    "INSERT INTO public.presentation_update_runs (id, subject_id, subject_name, status, job_queue, total_jobs, updated_at) VALUES ($1, $2, 'Maths', 'processing', $3::jsonb, $4, now() - interval '5 minutes')",
    [id, randomUUID(), JSON.stringify(queue), queue.length]
  );
  return { id, videoIds };
}

describe("presentation-update-worker", () => {
  before(async () => {
    await startServer();
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    stub = http.createServer(stubHandler);
    stub.listen(0, "127.0.0.1");
    await once(stub, "listening");
    process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${stub.address().port}`;
    process.env.CRON_SECRET = SECRET;
    process.env.SERVICE_ROLE_KEY = SERVICE;

    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/", router);
    fnServer = app.listen(0, "127.0.0.1");
    await once(fnServer, "listening");
    fnBase = `http://127.0.0.1:${fnServer.address().port}`;
  });

  after(async () => {
    if (createdRuns.length) await q("DELETE FROM public.presentation_update_runs WHERE id = ANY($1)", [createdRuns]);
    if (createdJobs.length) await q("DELETE FROM public.video_generation_jobs WHERE id = ANY($1)", [createdJobs]);
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await new Promise((r) => fnServer.close(r));
    await new Promise((r) => stub.close(r));
    await stopServer();
  });

  it("refuses callers without the cron secret", async () => {
    const none = await runWorker({});
    assert.equal(none.status, 401);
    const wrong = await runWorker({ Authorization: "Bearer nope" });
    assert.equal(wrong.status, 401);
  });

  it("refuses to run when CRON_SECRET is not configured", async () => {
    const saved = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      const r = await runWorker();
      assert.equal(r.status, 500);
    } finally {
      process.env.CRON_SECRET = saved;
    }
  });

  it("reports no active runs when none are processing", async () => {
    const pending = await q("SELECT count(*)::int n FROM public.presentation_update_runs WHERE status = 'processing'");
    if (pending[0].n > 0) return; // another run is in flight in this database; nothing to assert
    const r = await runWorker();
    assert.equal(r.status, 200);
    assert.equal(r.body.message, "No active runs");
  });

  it("completes a run with no jobs", async () => {
    const run = await makeRun([]);
    const r = await runWorker();
    assert.equal(r.body.success, true);
    const [row] = await q("SELECT status FROM public.presentation_update_runs WHERE id = $1", [run.id]);
    assert.equal(row.status, "completed");
  });

  it("updates presentation_json for good jobs, skips unreachable servers, fails bad reviews", async () => {
    const run = await makeRun([{ ext: "ok-job" }, { ext: "down-job" }, { ext: "bad-job" }]);
    const r = await runWorker();
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);

    const [row] = await q("SELECT status, current_job_index, completed_jobs, failed_jobs, skipped_jobs, job_queue FROM public.presentation_update_runs WHERE id = $1", [run.id]);
    assert.equal(row.status, "completed");
    assert.equal(row.current_job_index, 3);
    assert.equal(row.completed_jobs, 1);
    assert.equal(row.failed_jobs, 1);
    assert.equal(row.skipped_jobs, 1);
    assert.equal(row.job_queue[1].status, "skipped");
    assert.equal(row.job_queue[2].status, "failed");
    assert.equal(row.job_queue[2].error_message, "boom: bad review");

    const [vj] = await q("SELECT presentation_json FROM public.video_generation_jobs WHERE id = $1", [run.videoIds[0]]);
    assert.equal(vj.presentation_json.sections.length, 2);
    assert.ok(proxyCalls.some((c) => c.auth === `Bearer ${SERVICE}`), "proxy call carries the service key");
  });

  it("does not touch a cancelled run", async () => {
    const run = await makeRun([{ ext: "ok-job" }]);
    await q("UPDATE public.presentation_update_runs SET status = 'cancelled' WHERE id = $1", [run.id]);
    const before = proxyCalls.length;
    await runWorker();
    assert.equal(proxyCalls.length, before, "no proxy call for a cancelled run");
    const [row] = await q("SELECT status, current_job_index FROM public.presentation_update_runs WHERE id = $1", [run.id]);
    assert.equal(row.status, "cancelled");
    assert.equal(row.current_job_index, 0);
  });
});
