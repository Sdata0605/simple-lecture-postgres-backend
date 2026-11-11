import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser } from "./helpers.js";
import { serveRouter } from "./router-harness.js";
import { router } from "../functions/api/index.js";

describe("api", () => {
  let svc;
  before(async () => {
    await startServer();
    svc = await serveRouter(router);
  });
  after(async () => {
    await svc?.close();
    await stopServer();
  });

  it("lists active subjects, categories and courses", async () => {
    const subjects = await svc.get("subjects");
    assert.equal(subjects.status, 200);
    assert.ok(Array.isArray(subjects.body));
    const cats = await svc.get("categories");
    assert.ok(Array.isArray(cats.body));
    const courses = await svc.get("courses?page=1&limit=5");
    assert.equal(courses.status, 200);
    assert.equal(courses.body.page, 1);
    assert.equal(courses.body.limit, 5);
    assert.ok(Array.isArray(courses.body.data));
    assert.equal(courses.body.totalPages, Math.ceil(courses.body.total / 5));
  });

  it("a missing course is an error", async () => {
    const r = await svc.get("courses/00000000-0000-4000-8000-000000000000");
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "Course not found");
  });

  it("enrollments need a token", async () => {
    const r = await svc.get("student/enrollments");
    assert.equal(r.status, 401);
    const u = await makeUser();
    const ok = await svc.get("student/enrollments", { Authorization: `Bearer ${u.access}` });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, []);
  });

  it("unknown routes return 404 JSON", async () => {
    const r = await svc.get("nope");
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: "Not found" });
  });
});
