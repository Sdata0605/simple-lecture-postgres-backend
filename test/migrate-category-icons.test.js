import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { serveRouter, hitAt } from "./route-harness.js";
import { router } from "../functions/migrate-category-icons/index.js";

describe("migrate-category-icons", () => {
  let r;
  let student;
  let admin;
  before(async () => {
    await startServer();
    r = await serveRouter("/functions/v1/migrate-category-icons", router);
    student = await makeUser();
    admin = await makeUser();
    await q("INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')", [admin.id]);
  });
  after(async () => {
    await q("DELETE FROM public.user_roles WHERE user_id = $1 AND role = 'admin'", [admin.id]);
    await r.close();
    await stopServer();
  });

  it("requires an Authorization header", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/migrate-category-icons", { body: {} });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: "Authorization required" });
  });

  it("rejects an invalid token", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/migrate-category-icons", {
      body: {},
      headers: { Authorization: "Bearer not-a-jwt" },
    });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: "Invalid token" });
  });

  it("rejects a non-admin with 403", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/migrate-category-icons", {
      body: {},
      headers: { Authorization: `Bearer ${student.access}` },
    });
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: "Admin access required" });
  });

  it("lets an admin run and returns the summary shape", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/migrate-category-icons", {
      body: {},
      headers: { Authorization: `Bearer ${admin.access}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    for (const k of ["migrated", "skipped", "errors", "total"]) assert.equal(typeof res.body.summary[k], "number");
    assert.ok(Array.isArray(res.body.results));
  });
});
