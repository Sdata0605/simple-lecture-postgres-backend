import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import "./helpers.js";
import { router } from "../functions/admin-backfill-subject/index.js";
import { mountRouter, closeDb } from "./_group00-harness.js";

let app;
const TOKEN = "backfill-test-token-not-real";
const savedToken = process.env.BACKFILL_ADMIN_TOKEN;
const withToken = (headers = {}) => ({ "x-admin-token": TOKEN, ...headers });

describe("admin-backfill-subject", () => {
  before(async () => {
    process.env.BACKFILL_ADMIN_TOKEN = TOKEN;
    app = await mountRouter("/", router);
  });
  after(async () => {
    if (savedToken === undefined) delete process.env.BACKFILL_ADMIN_TOKEN;
    else process.env.BACKFILL_ADMIN_TOKEN = savedToken;
    await app.close();
    await closeDb();
  });

  it("refuses a missing or wrong admin token with 401", async () => {
    assert.equal((await app.post("/", { subject: "Physics" })).status, 401);
    const wrong = await app.post("/", { subject: "Physics" }, { "x-admin-token": "nope" });
    assert.equal(wrong.status, 401);
  });

  it("refuses everything when the token is not configured", async () => {
    const saved = process.env.BACKFILL_ADMIN_TOKEN;
    delete process.env.BACKFILL_ADMIN_TOKEN;
    try {
      assert.equal((await app.post("/", { subject: "Physics" }, withToken())).status, 401);
    } finally {
      process.env.BACKFILL_ADMIN_TOKEN = saved;
    }
  });

  it("requires a subject", async () => {
    const r = await app.post("/", {}, withToken());
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "subject required");
  });

  it("with the right token and an unknown subject, reports nothing to fill", async () => {
    const r = await app.post("/", { subject: `no-such-subject-${Date.now()}` }, withToken());
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.missing_before, 0);
    assert.equal(r.body.filled, 0);
    assert.deepEqual(r.body.report, []);
  });
});
