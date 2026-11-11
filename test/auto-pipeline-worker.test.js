import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser } from "./helpers.js";
import { serveRouter, setEnv } from "./router-harness.js";
import { router } from "../functions/auto-pipeline-worker/index.js";

// Only authorisation is tested here. A run would submit jobs to generation servers.
describe("auto-pipeline-worker", () => {
  let svc, restore;
  before(async () => {
    await startServer();
    svc = await serveRouter(router);
    restore = setEnv({ SERVICE_KEY: "test-service-key" });
  });
  after(async () => {
    restore?.();
    await svc?.close();
    await stopServer();
  });

  it("refuses callers without the service key or an admin token", async () => {
    const r = await svc.post({});
    assert.equal(r.status, 401);
    const u = await makeUser();
    const r2 = await svc.post({}, { Authorization: `Bearer ${u.access}` });
    assert.equal(r2.status, 401);
  });
});
