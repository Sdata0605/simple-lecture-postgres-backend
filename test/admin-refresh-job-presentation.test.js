import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import "./helpers.js";
import { router } from "../functions/admin-refresh-job-presentation/index.js";
import { mountRouter, closeDb } from "./_group00-harness.js";

let app;
const KEY = "refresh-test-key-not-real";
const savedKey = process.env.ADMIN_SERVICE_KEY;
const withKey = { "x-service-key": KEY };

describe("admin-refresh-job-presentation", () => {
  before(async () => {
    process.env.ADMIN_SERVICE_KEY = KEY;
    app = await mountRouter("/", router);
  });
  after(async () => {
    if (savedKey === undefined) delete process.env.ADMIN_SERVICE_KEY;
    else process.env.ADMIN_SERVICE_KEY = savedKey;
    await app.close();
    await closeDb();
  });

  it("refuses requests without the service key", async () => {
    assert.equal((await app.post("/", { job_id: "x" })).status, 401);
  });

  it("an unknown job is a 404", async () => {
    const byId = await app.post("/", { job_id: `no-such-job-${crypto.randomUUID()}` }, withKey);
    assert.equal(byId.status, 404);
    assert.equal(byId.body.error, "job not found");
    const byExt = await app.post("/", { external_job_id: `no-such-ext-${crypto.randomUUID()}` }, withKey);
    assert.equal(byExt.status, 404);
  });

  it("with neither id, it is a 404 too", async () => {
    assert.equal((await app.post("/", {}, withKey)).status, 404);
  });
});
