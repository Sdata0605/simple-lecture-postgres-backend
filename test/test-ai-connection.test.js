import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { q, uniqueEmail } from "./helpers.js";
import { pool } from "../functions/_shared/db.js";
import { createAuthUser } from "../functions/_shared/accounts.js";
import { issueSession } from "../functions/_shared/session.js";
import { router } from "../functions/test-ai-connection/index.js";

const SERVICE = "test-service-key-not-real-0001";
let server;
let base;
let admin;
let student;

// A real signed-in user, optionally with an extra role. Cleanup removes every row it created.
async function makeUserRow(role) {
  const u = await createAuthUser({ email: uniqueEmail("g5"), password: "Pass!word1", fullName: "G5 Test" });
  if (role !== "student") {
    await q("INSERT INTO public.user_roles (user_id, role) VALUES ($1, $2::app_role) ON CONFLICT DO NOTHING", [u.id, role]);
  }
  const session = await issueSession(u);
  return {
    id: u.id,
    access: session.access_token,
    cleanup: async () => {
      await q("DELETE FROM public.auth_refresh_tokens WHERE user_id = $1", [u.id]);
      await q("DELETE FROM public.user_roles WHERE user_id = $1", [u.id]);
      await q("DELETE FROM public.profiles WHERE id = $1", [u.id]);
      await q("DELETE FROM auth.users WHERE id = $1", [u.id]);
    },
  };
}

const post = async (body, token) => {
  const r = await fetch(`${base}/functions/v1/test-ai-connection`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

describe("test-ai-connection", () => {
  before(async () => {
    process.env.SERVICE_ROLE_KEY = SERVICE;
    const app = express();
    app.use(express.json());
    app.use("/functions/v1/test-ai-connection", router);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
    admin = await makeUserRow("admin");
    student = await makeUserRow("student");
  });

  after(async () => {
    await admin.cleanup();
    await student.cleanup();
    await new Promise((r) => server.close(r));
    await pool.end();
  });

  it("refuses callers without the service key or an admin token", async () => {
    assert.equal((await post({ provider: "openai", apiKey: "k", model: "m" })).status, 401);
    assert.equal((await post({ provider: "openai", apiKey: "k", model: "m" }, student.access)).status, 401);
  });

  it("requires provider, apiKey and model", async () => {
    const r = await post({ provider: "openai" }, SERVICE);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "Missing required fields: provider, apiKey, model");
  });

  it("rejects an unknown provider before any network call", async () => {
    const r = await post({ provider: "nope", apiKey: "k", model: "m" }, admin.access);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Invalid provider/);
  });
});
