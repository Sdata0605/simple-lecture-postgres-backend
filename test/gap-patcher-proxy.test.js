import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { serveRouter, hitAt } from "./route-harness.js";
import { router } from "../functions/gap-patcher-proxy/index.js";

describe("gap-patcher-proxy", () => {
  let upstream;
  let r;
  let admin;
  let student;
  const savedBase = process.env.GAP_PATCHER_BASE_URL;
  before(async () => {
    // Local stand-in for the gap patcher service. No real upstream is contacted.
    upstream = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ path: req.url }));
    }).listen(0, "127.0.0.1");
    await once(upstream, "listening");
    process.env.GAP_PATCHER_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
    await startServer();
    r = await serveRouter("/functions/v1/gap-patcher-proxy", router);
    student = await makeUser();
    admin = await makeUser();
    await q("INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING", [admin.id]);
  });
  after(async () => {
    await q("DELETE FROM public.user_roles WHERE user_id = $1 AND role = 'admin'", [admin.id]);
    await r.close();
    await stopServer();
    await new Promise((res) => upstream.close(res));
    if (savedBase === undefined) delete process.env.GAP_PATCHER_BASE_URL;
    else process.env.GAP_PATCHER_BASE_URL = savedBase;
  });

  it("rejects requests without a Bearer token", async () => {
    const res = await hitAt(r.base, "GET", "/functions/v1/gap-patcher-proxy/api/health");
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: "Unauthorized" });
  });

  it("rejects a signed-in non-admin with 403", async () => {
    const res = await hitAt(r.base, "GET", "/functions/v1/gap-patcher-proxy/api/health", {
      headers: { Authorization: `Bearer ${student.access}` },
    });
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: "Forbidden" });
  });

  it("forwards an admin request to the configured base URL", async () => {
    const res = await hitAt(r.base, "GET", "/functions/v1/gap-patcher-proxy/api/status?x=1", {
      headers: { Authorization: `Bearer ${admin.access}` },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { path: "/api/status?x=1" });
  });

  it("maps the root path to the health endpoint", async () => {
    const res = await hitAt(r.base, "GET", "/functions/v1/gap-patcher-proxy", {
      headers: { Authorization: `Bearer ${admin.access}` },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { path: "/api/health" });
  });
});
