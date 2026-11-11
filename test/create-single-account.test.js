import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, q, uniqueEmail } from "./helpers.js";
import { mountRouter, request } from "./group02-harness.js";
import { router } from "../functions/create-single-account/index.js";

const KEY = "svc-test-key-0123456789abcdef";
const svc = { "x-service-key": KEY };

async function purge(email) {
  await q("DELETE FROM public.enrollments WHERE student_id IN (SELECT id FROM auth.users WHERE email = $1)", [email]);
  await q("DELETE FROM public.user_roles WHERE user_id IN (SELECT id FROM auth.users WHERE email = $1)", [email]);
  await q("DELETE FROM public.profiles WHERE id IN (SELECT id FROM auth.users WHERE email = $1)", [email]);
  await q("DELETE FROM auth.users WHERE email = $1", [email]);
}

describe("create-single-account", () => {
  let app;
  const emails = [];
  const savedKey = process.env.INTERNAL_SERVICE_KEY;
  let courseId;
  before(async () => {
    process.env.INTERNAL_SERVICE_KEY = KEY;
    await startServer();
    app = await mountRouter("/functions/v1/create-single-account", router);
    [{ id: courseId }] = await q("SELECT id FROM public.courses LIMIT 1");
  });
  after(async () => {
    for (const e of emails) await purge(e);
    if (savedKey === undefined) delete process.env.INTERNAL_SERVICE_KEY;
    else process.env.INTERNAL_SERVICE_KEY = savedKey;
    await app.close();
    await stopServer();
  });

  it("refuses requests without the service key", async () => {
    const r = await request(app.base, { body: { email: "x@example.test", password: "p", courseId } });
    assert.equal(r.status, 401);
  });

  it("validates its fields", async () => {
    const r = await request(app.base, { body: { email: uniqueEmail("solo") }, headers: svc });
    assert.equal(r.status, 400);
  });

  it("creates a student, enrols it for a year, and reports updates on a repeat", async () => {
    const email = uniqueEmail("solo");
    emails.push(email);
    const body = { email, password: "Solo!pass1", full_name: "Solo Student", courseId };

    const first = await request(app.base, { body, headers: svc });
    assert.equal(first.status, 200);
    assert.equal(first.body.status, "created");
    const [enr] = await q(
      "SELECT is_active, expires_at FROM public.enrollments WHERE student_id = $1 AND course_id = $2",
      [first.body.user_id, courseId]
    );
    assert.equal(enr.is_active, true);
    assert.ok(new Date(enr.expires_at).getTime() > Date.now() + 300 * 24 * 3600 * 1000);

    const second = await request(app.base, { body: { ...body, password: "Solo!pass2" }, headers: svc });
    assert.equal(second.status, 200);
    assert.equal(second.body.status, "updated");
    assert.equal(second.body.user_id, first.body.user_id);
  });
});
