import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser } from "./helpers.js";
import { serveRouter } from "./router-harness.js";
import { router } from "../functions/award-badge/index.js";

describe("award-badge", () => {
  let svc;
  before(async () => {
    await startServer();
    svc = await serveRouter(router);
  });
  after(async () => {
    await svc?.close();
    await stopServer();
  });

  it("requires an auth header", async () => {
    const r = await svc.post({ topicId: "x" });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "No auth header");
  });

  it("rejects an invalid token", async () => {
    const r = await svc.post({ topicId: "x" }, { Authorization: "Bearer nope" });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "Unauthorized");
  });

  it("awards nothing when no ids are given", async () => {
    const u = await makeUser();
    const r = await svc.post({}, { Authorization: `Bearer ${u.access}` });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { success: true, badges_awarded: [] });
  });
});
