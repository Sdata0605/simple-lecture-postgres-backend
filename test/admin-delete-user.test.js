import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { makeUser, q, startServer, stopServer } from "./helpers.js";
import { router } from "../functions/admin-delete-user/index.js";
import { mountRouter } from "./_group00-harness.js";

let app;
const KEY = "admin-delete-test-key-not-real";
const savedKey = process.env.ADMIN_SERVICE_KEY;
const withKey = { "x-service-key": KEY };

describe("admin-delete-user", () => {
  before(async () => {
    process.env.ADMIN_SERVICE_KEY = KEY;
    app = await mountRouter("/", router);
    await startServer(); // makeUser() signs up through the app
  });
  after(async () => {
    if (savedKey === undefined) delete process.env.ADMIN_SERVICE_KEY;
    else process.env.ADMIN_SERVICE_KEY = savedKey;
    await app.close();
    await stopServer();
  });

  it("refuses requests without the service key", async () => {
    assert.equal((await app.post("/", { user_id: crypto.randomUUID() })).status, 401);
    assert.equal((await app.post("/", { user_id: crypto.randomUUID() }, { "x-service-key": "wrong" })).status, 401);
  });

  it("requires user_id", async () => {
    const r = await app.post("/", {}, withKey);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "user_id is required");
  });

  it("an unknown user is a 500 'User not found' with cleanup results", async () => {
    const r = await app.post("/", { user_id: crypto.randomUUID() }, withKey);
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "User not found");
    assert.ok(Array.isArray(r.body.cleanup_results));
    assert.ok(r.body.cleanup_results.includes("profiles: OK"));
  });

  it("deletes a real test user and reports success", async () => {
    const u = await makeUser();
    const r = await app.post("/", { user_id: u.id, phone_number: "9000000000" }, withKey);
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.message, "User deleted successfully");
    assert.ok(r.body.cleanup_results.includes("phone_otp: OK"));
    const left = await q("SELECT id FROM auth.users WHERE id = $1", [u.id]);
    assert.equal(left.length, 0);
  });
});
