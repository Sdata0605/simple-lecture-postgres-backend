import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser, q, uniqueEmail } from "./helpers.js";
import { mountRouter, request, bearer, makeAdmin } from "./group02-harness.js";
import { router } from "../functions/create-instructor/index.js";

describe("create-instructor", () => {
  let app;
  let admin;
  const emails = [];
  before(async () => {
    await startServer();
    app = await mountRouter("/functions/v1/create-instructor", router);
    admin = await makeAdmin();
  });
  after(async () => {
    for (const email of emails) {
      await q("DELETE FROM public.teacher_profiles WHERE email = $1", [email]);
      await q("DELETE FROM public.user_roles WHERE user_id IN (SELECT id FROM auth.users WHERE email = $1)", [email]);
      await q("DELETE FROM public.profiles WHERE id IN (SELECT id FROM auth.users WHERE email = $1)", [email]);
      await q("DELETE FROM auth.users WHERE email = $1", [email]);
    }
    await q("DELETE FROM public.user_roles WHERE user_id = $1", [admin.id]);
    await app.close();
    await stopServer();
  });

  it("requires a signed-in admin", async () => {
    assert.equal((await request(app.base, { body: {} })).status, 401);
    const student = await makeUser();
    const r = await request(app.base, { body: { instructorData: {} }, headers: bearer(student.access) });
    assert.equal(r.status, 403);
  });

  it("requires email, full name and password", async () => {
    const r = await request(app.base, { body: { instructorData: { email: uniqueEmail("ins") } }, headers: bearer(admin.access) });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "Email, full name, and password are required");
  });

  it("creates a teacher account and profile, and refuses a second use of the same email", async () => {
    const email = uniqueEmail("instructor");
    emails.push(email);
    const data = { email, full_name: "Ada Teacher", password: "Teach!ng123", employee_id: `E-${Date.now()}`, qualification: "MSc" };

    const r = await request(app.base, { body: { instructorData: data }, headers: bearer(admin.access) });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.profile.email, email);
    assert.equal(r.body.profile.full_name, "Ada Teacher");

    const roles = await q("SELECT role FROM public.user_roles WHERE user_id = $1", [r.body.profile.id]);
    assert.ok(roles.some((x) => x.role === "teacher"));

    const again = await request(app.base, { body: { instructorData: data }, headers: bearer(admin.access) });
    assert.equal(again.status, 400);
    assert.match(again.body.error, /already exists/);
  });
});
