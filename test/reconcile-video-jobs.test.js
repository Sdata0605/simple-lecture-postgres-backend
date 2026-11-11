import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { startServer, stopServer, q } from "./helpers.js";
import { router } from "../functions/reconcile-video-jobs/index.js";

// Both proxy routes are replaced by one local stub (PUBLIC_BASE_URL). No real host is contacted.
const SECRET = "test-cron-secret";
let stub;
let fnServer;
let fnBase;
const savedEnv = {};
const jobIds = [];
const proxyHits = [];

// Reply chosen from the external_job_id the reconciler asks about.
function stubReply(jobId) {
  if (jobId === "rc-done") return { status: 200, body: { status: "completed" } };
  if (jobId === "rc-fail") return { status: 200, body: { status: "failed", error_message: "pipeline broke" } };
  if (jobId === "rc-run") return { status: 200, body: { status: "processing", progress: 42, current_step: "rendering" } };
  if (jobId === "rc-mkt") return { status: 200, body: { status: "completed_with_errors" } };
  return { status: 404, body: { error: "not found" } }; // rc-lost and anything unknown
}

async function makeJob(id, extra = {}) {
  const row = {
    id,
    external_job_id: extra.external_job_id ?? id,
    server_ip: "test-host",
    target_port: extra.target_port ?? 5005,
    status: extra.status ?? "processing",
    progress: extra.progress ?? 10,
    reconcile_miss_count: extra.reconcile_miss_count ?? 0,
    updated_at: extra.updated_at ?? new Date(),
  };
  jobIds.push(id);
  await q(
    `INSERT INTO public.video_generation_jobs (id, subject_id, external_job_id, server_ip, target_port, status, progress, reconcile_miss_count, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [row.id, randomUUID(), row.external_job_id, row.server_ip, row.target_port, row.status, row.progress, row.reconcile_miss_count, row.updated_at]
  );
  return row.id;
}

const job = async (id) => (await q("SELECT * FROM public.video_generation_jobs WHERE id = $1", [id]))[0];
const newId = (tag) => `${tag}${Math.random().toString(36).slice(2, 6)}`;

async function run(headers = { Authorization: `Bearer ${SECRET}` }) {
  const res = await fetch(`${fnBase}/`, { method: "POST", headers });
  return { status: res.status, body: await res.json() };
}

describe("reconcile-video-jobs", () => {
  before(async () => {
    await startServer();
    for (const k of ["PUBLIC_BASE_URL", "CRON_SECRET", "SERVICE_ROLE_KEY", "SERVICE_KEY"]) savedEnv[k] = process.env[k];
    process.env.SERVICE_ROLE_KEY = "test-service-role";
    process.env.SERVICE_KEY = "test-service-key";

    stub = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        proxyHits.push({ route: req.url, auth: req.headers.authorization, job: body.job_id, port: body.target_port });
        const reply = stubReply(body.job_id);
        res.writeHead(reply.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply.body));
      });
    });
    stub.listen(0, "127.0.0.1");
    await once(stub, "listening");
    process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${stub.address().port}`;
    process.env.CRON_SECRET = SECRET;

    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/", router);
    fnServer = app.listen(0, "127.0.0.1");
    await once(fnServer, "listening");
    fnBase = `http://127.0.0.1:${fnServer.address().port}`;
  });

  after(async () => {
    try {
      if (jobIds.length) await q("DELETE FROM public.video_generation_jobs WHERE id = ANY($1)", [jobIds]);
    } finally {
      for (const k of Object.keys(savedEnv)) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
      await new Promise((r) => fnServer.close(r));
      await new Promise((r) => stub.close(r));
      await stopServer();
    }
  });

  it("refuses callers without the cron secret", async () => {
    assert.equal((await run({})).status, 401);
    assert.equal((await run({ Authorization: "Bearer wrong" })).status, 401);
  });

  it("refuses to run when CRON_SECRET is not configured", async () => {
    const saved = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      assert.equal((await run()).status, 500);
    } finally {
      process.env.CRON_SECRET = saved;
    }
  });

  it("marks a completed upstream job completed at 100%", async () => {
    const id = await makeJob(newId("rc"), { external_job_id: "rc-done" });
    const r = await run();
    assert.equal(r.status, 200);
    assert.ok(r.body.checked >= 1);
    const j = await job(id);
    assert.equal(j.status, "completed");
    assert.equal(j.progress, 100);
    assert.ok(j.completed_at);
  });

  it("marks an upstream failure failed with its error message", async () => {
    const id = await makeJob(newId("rc"), { external_job_id: "rc-fail" });
    await run();
    const j = await job(id);
    assert.equal(j.status, "failed");
    assert.equal(j.error_message, "pipeline broke");
  });

  it("refreshes a still-running job's progress and step", async () => {
    const id = await makeJob(newId("rc"), { external_job_id: "rc-run", reconcile_miss_count: 2 });
    await run();
    const j = await job(id);
    assert.equal(j.status, "processing");
    assert.equal(j.progress, 42);
    assert.equal(j.current_step, "rendering");
    assert.equal(j.reconcile_miss_count, 0);
  });

  it("counts misses and fails the job after the third one", async () => {
    const id = await makeJob(newId("rc"), { external_job_id: "rc-lost", reconcile_miss_count: 0 });
    await run();
    assert.equal((await job(id)).reconcile_miss_count, 1);
    await run();
    await run();
    const j = await job(id);
    assert.equal(j.status, "failed");
    assert.equal(j.error_message, "Upstream lost job (reconciler)");
    assert.equal(j.reconcile_miss_count, 3);
  });

  it("routes marketing-port jobs through the marketing proxy", async () => {
    const id = await makeJob(newId("rc"), { external_job_id: "rc-mkt", target_port: 5006 });
    await run();
    assert.ok(proxyHits.some((h) => h.route === "/functions/v1/marketing-video-proxy" && h.job === "rc-mkt"));
    assert.equal((await job(id)).status, "completed_with_errors");
  });

  it("sends each proxy the service key it accepts", async () => {
    assert.ok(proxyHits.length > 0);
    const video = proxyHits.filter((h) => h.route.endsWith("/video-generation-proxy"));
    const mkt = proxyHits.filter((h) => h.route.endsWith("/marketing-video-proxy"));
    assert.ok(video.every((h) => h.auth === "Bearer test-service-role"));
    assert.ok(mkt.every((h) => h.auth === "Bearer test-service-key"));
  });

  it("fails a job with no progress after six hours", async () => {
    const old = new Date(Date.now() - 7 * 3600 * 1000);
    const id = await makeJob(newId("rc"), { external_job_id: "rc-old", progress: 0, updated_at: old });
    await run();
    const j = await job(id);
    assert.equal(j.status, "failed");
    assert.match(j.error_message, /no progress for 6h/);
  });
});
