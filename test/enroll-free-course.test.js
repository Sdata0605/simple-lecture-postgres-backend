import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, post, makeUser, q } from "./helpers.js";

const act = (u, body) => post("/functions/v1/enroll-free-course", body, { Authorization: `Bearer ${u.access}` });

// Courses created here are removed in after(), so they do not pollute the catalog the UI reads.
const createdCourseIds = [];

async function makeCourse({ price = 0, active = true } = {}) {
  const [{ id }] = await q(
    "INSERT INTO public.courses (name, slug, price_inr, is_active) VALUES ($1, $2, $3, $4) RETURNING id",
    [`Test course ${Math.random()}`, `test-course-${Math.random().toString(36).slice(2)}`, price, active]
  );
  createdCourseIds.push(id);
  return id;
}

describe("enroll-free-course", () => {
  before(startServer);
  after(async () => {
    if (createdCourseIds.length) {
      await q("DELETE FROM public.enrollments WHERE course_id = ANY($1::uuid[])", [createdCourseIds]);
      await q("DELETE FROM public.courses WHERE id = ANY($1::uuid[])", [createdCourseIds]);
    }
    await stopServer();
  });

  it("requires a bearer token", async () => {
    assert.equal((await post("/functions/v1/enroll-free-course", { courseId: "x" })).status, 401);
  });

  it("requires courseId", async () => {
    const u = await makeUser();
    const r = await act(u, {});
    assert.equal(r.status, 400);
  });

  it("unknown course gives 404; inactive course 400; paid course 403", async () => {
    const u = await makeUser();
    assert.equal((await act(u, { courseId: "00000000-0000-4000-8000-0000000000bb" })).status, 404);
    const inactive = await makeCourse({ active: false });
    assert.equal((await act(u, { courseId: inactive })).status, 400);
    const paid = await makeCourse({ price: 500 });
    assert.equal((await act(u, { courseId: paid })).status, 403);
  });

  it("a free active course enrols the student once; a second call does not duplicate", async () => {
    const u = await makeUser();
    const course = await makeCourse();
    assert.deepEqual(await act(u, { courseId: course }).then((r) => r.body), { enrolled: true });
    assert.equal((await act(u, { courseId: course })).status, 200);
    const rows = await q("SELECT is_active FROM public.enrollments WHERE student_id = $1 AND course_id = $2", [u.id, course]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].is_active, true);
  });
});
