import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { q, uniqueEmail } from "./helpers.js";
import { pool } from "../functions/_shared/db.js";
import { sentMessages } from "../functions/_shared/mail.js";
import { createAuthUser } from "../functions/_shared/accounts.js";
import { router } from "../functions/send-welcome-email/index.js";

const SERVICE = "test-service-key-not-real-0003";
let server;
let base;
let user;
const email = uniqueEmail("welcome");

const post = async (body, token) => {
  const r = await fetch(`${base}/functions/v1/send-welcome-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

describe("send-welcome-email", () => {
  before(async () => {
    process.env.SERVICE_ROLE_KEY = SERVICE;
    const app = express();
    app.use(express.json());
    app.use("/functions/v1/send-welcome-email", router);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
    user = await createAuthUser({ email, password: "Pass!word1", fullName: "Welcome Test" });
  });

  after(async () => {
    await q("DELETE FROM public.welcome_email_logs WHERE user_id = $1", [user.id]);
    await q("DELETE FROM public.user_roles WHERE user_id = $1", [user.id]);
    await q("DELETE FROM public.profiles WHERE id = $1", [user.id]);
    await q("DELETE FROM auth.users WHERE id = $1", [user.id]);
    await new Promise((r) => server.close(r));
    await pool.end();
  });

  it("refuses an unrelated caller", async () => {
    const r = await post({ user_id: user.id, email }, "not-a-real-token");
    assert.equal(r.status, 401);
  });

  it("requires user_id and email", async () => {
    const r = await post({ user_id: user.id }, SERVICE);
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: "user_id and email required" });
  });

  it("sends once (dry-run) and logs it", async () => {
    const r = await post({ user_id: user.id, email, full_name: "Welcome Test" }, SERVICE);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { message: "Welcome email sent", email });
    assert.ok(sentMessages.some((m) => m.to === email && /Welcome to SimpleLecture/.test(m.subject)));
    const rows = await q("SELECT status FROM public.welcome_email_logs WHERE user_id = $1", [user.id]);
    assert.deepEqual(rows.map((x) => x.status), ["sent"]);
  });

  it("skips a second send", async () => {
    const before = sentMessages.length;
    const r = await post({ user_id: user.id, email }, SERVICE);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { message: "Already sent" });
    assert.equal(sentMessages.length, before);
  });
});
