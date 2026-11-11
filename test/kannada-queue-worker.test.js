import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, q, makeUser } from "./helpers.js";
import { serveRouter, hitAt } from "./route-harness.js";
import { router, hooks, serverList } from "../functions/kannada-queue-worker/index.js";

describe("kannada-queue-worker", () => {
  let r;
  const saved = {
    svc: process.env.SERVICE_KEY,
    normal: process.env.KANNADA_NORMAL_SERVER_IP,
    cloud: process.env.KANNADA_CLOUD_SERVER_IP,
    actor: process.env.KANNADA_WORKER_ADMIN_ID,
  };
  let actor;
  const realFetch = hooks.fetch;
  const TEST_SERVER = "test-normal-server";
  before(async () => {
    await startServer();
    r = await serveRouter("/functions/v1/kannada-queue-worker", router);
    process.env.SERVICE_KEY = "test-service-key-not-real";
    actor = await makeUser();
    await q("INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')", [actor.id]);
    process.env.KANNADA_WORKER_ADMIN_ID = actor.id;
  });
  after(async () => {
    hooks.fetch = realFetch;
    for (const [k, envName] of [["svc", "SERVICE_KEY"], ["normal", "KANNADA_NORMAL_SERVER_IP"], ["cloud", "KANNADA_CLOUD_SERVER_IP"], ["actor", "KANNADA_WORKER_ADMIN_ID"]]) {
      if (saved[k] === undefined) delete process.env[envName];
      else process.env[envName] = saved[k];
    }
    await q("DELETE FROM public.user_roles WHERE user_id = $1 AND role = 'admin'", [actor.id]);
    await r.close();
    await stopServer();
  });

  it("is closed to callers without the cron key", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/kannada-queue-worker", { body: {} });
    assert.equal(res.status, 401);
    const wrong = await hitAt(r.base, "POST", "/functions/v1/kannada-queue-worker", {
      body: {},
      headers: { "x-service-key": "wrong" },
    });
    assert.equal(wrong.status, 401);
  });

  it("reads server addresses only from the environment", () => {
    delete process.env.KANNADA_NORMAL_SERVER_IP;
    delete process.env.KANNADA_CLOUD_SERVER_IP;
    assert.deepEqual(serverList().servers, []);
    process.env.KANNADA_NORMAL_SERVER_IP = "10.0.0.1";
    process.env.KANNADA_CLOUD_SERVER_IP = "10.0.0.2";
    const s = serverList();
    assert.deepEqual(s.servers, ["10.0.0.1", "10.0.0.2"]);
    assert.equal(s.cloud, "10.0.0.2");
  });

  it("does nothing and reports ok when no servers are configured", async () => {
    delete process.env.KANNADA_NORMAL_SERVER_IP;
    delete process.env.KANNADA_CLOUD_SERVER_IP;
    const res = await hitAt(r.base, "POST", "/functions/v1/kannada-queue-worker", {
      body: {},
      headers: { "x-service-key": process.env.SERVICE_KEY },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, results: [] });
  });

  it("reports an idle server when it has nothing queued (no render call)", async () => {
    process.env.KANNADA_NORMAL_SERVER_IP = TEST_SERVER;
    delete process.env.KANNADA_CLOUD_SERVER_IP;
    let renderCalls = 0;
    hooks.fetch = async () => {
      renderCalls += 1;
      return new Response("{}", { status: 500 });
    };
    await q("DELETE FROM public.kannada_queue_items WHERE server_ip = $1", [TEST_SERVER]);
    const res = await hitAt(r.base, "POST", "/functions/v1/kannada-queue-worker", {
      body: {},
      headers: { "x-service-key": process.env.SERVICE_KEY },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.results.some((x) => x.server === TEST_SERVER && x.idle === true));
    assert.equal(renderCalls, 0);
  });
});
