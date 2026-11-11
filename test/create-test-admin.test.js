import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, q, uniqueEmail } from "./helpers.js";
import { mountRouter, request } from "./group02-harness.js";
import { router } from "../functions/create-test-admin/index.js";

const KEY = "svc-test-key-0123456789abcdef";
const svc = { "x-service-key": KEY };

describe("create-test-admin", () => {
  let app;
  const emails = [];
  const savedKey = process.env.INTERNAL_SERVICE_KEY;
  before(async () => {
    process.env.INTERNAL_SERVICE_KEY = KEY;
    await startServer();
    app = await mountRouter("/functions/v1/create-test-admin", router);
  });
  after(async () => {
    for (const email of emails) {
      await q("DELETE FROM public.user_roles WHERE user_id IN (SELECT id FROM auth.users WHERE email = $1)", [email]);
      await q("DELETE FROM public.profiles WHERE id IN (SELECT id FROM auth.users WHERE email = $1)", [email]);
      await q("DELETE FROM auth.users WHERE email = $1", [email]);
    }
    if (savedKey === undefined) delete process.env.INTERNAL_SERVICE_KEY;
    else process.env.INTERNAL_SERVICE_KEY = savedKey;
    await app.close();
    await stopServer();
  });

  it("requires the service key", async () => {
    const r = await request(app.base, { body: { email: "a@example.test", password: "p" } });
    assert.equal(r.status, 401);
  });

  it("requires email and password", async () => {
    const r = await request(app.base, { body: { email: uniqueEmail("adm") }, headers: svc });
    assert.equal(r.status, 400);
  });

  it("creates an account with the admin role", async () => {
    const email = uniqueEmail("adm");
    emails.push(email);
    const r = await request(app.base, { body: { email, password: "Adm!pass12", full_name: "Test Admin" }, headers: svc });
    assert.equal(r.status, 200);
    assert.equal(r.body.email, email);
    const roles = await q("SELECT role FROM public.user_roles WHERE user_id = $1", [r.body.user_id]);
    assert.ok(roles.some((x) => x.role === "admin"));
  });
});
