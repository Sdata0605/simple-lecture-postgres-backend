import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import bcrypt from "bcryptjs";
import express from "express";
import { q, uniqueEmail } from "./helpers.js";
import { pool } from "../functions/_shared/db.js";
import { createAuthUser } from "../functions/_shared/accounts.js";
import { issueSession } from "../functions/_shared/session.js";
import { router } from "../functions/update-instructor-password/index.js";

const SERVICE = "test-service-key-not-real-0002";
let server;
let base;
let admin;
let teacher;
let teacherUser;
let profileId;

async function makeUserRow(role) {
  const u = await createAuthUser({ email: uniqueEmail("g5"), password: "Pass!word1", fullName: "G5 Test" });
  if (role !== "student") {
    await q("INSERT INTO public.user_roles (user_id, role) VALUES ($1, $2::app_role) ON CONFLICT DO NOTHING", [u.id, role]);
  }
  const session = await issueSession(u);
  return {
    id: u.id,
    email: u.email,
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
  const r = await fetch(`${base}/functions/v1/update-instructor-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

describe("update-instructor-password", () => {
  before(async () => {
    process.env.SERVICE_ROLE_KEY = SERVICE;
    const app = express();
    app.use(express.json());
    app.use("/functions/v1/update-instructor-password", router);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
    admin = await makeUserRow("admin");
    teacherUser = await makeUserRow("teacher");
    teacher = teacherUser;
    // teacher_profiles.id references the auth user, so the profile id is the user's id.
    profileId = teacherUser.id;
    await q(
      "INSERT INTO public.teacher_profiles (id, full_name, email, user_id) VALUES ($1, 'G5 Teacher', $2, $1)",
      [profileId, teacherUser.email]
    );
  });

  after(async () => {
    await q("DELETE FROM public.teacher_profiles WHERE id = $1", [profileId]);
    await admin.cleanup();
    await teacher.cleanup();
    await new Promise((r) => server.close(r));
    await pool.end();
  });

  it("refuses a non-admin user", async () => {
    const r = await post({ instructorId: profileId, newPassword: "New!pass123" }, teacher.access);
    assert.equal(r.status, 401);
  });

  it("returns 404 for an unknown instructor", async () => {
    const r = await post({ instructorId: "00000000-0000-4000-8000-0000000000ff", newPassword: "New!pass123" }, SERVICE);
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: "Instructor not found" });
  });

  it("rejects a password under six characters", async () => {
    const r = await post({ instructorId: profileId, newPassword: "abc" }, SERVICE);
    assert.equal(r.status, 400);
  });

  it("changes the linked account password when called by an admin", async () => {
    const r = await post({ instructorId: profileId, newPassword: "Brand!new99" }, admin.access);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { success: true, message: "Password updated successfully" });
    const [row] = await q("SELECT encrypted_password FROM auth.users WHERE id = $1", [teacher.id]);
    assert.equal(await bcrypt.compare("Brand!new99", row.encrypted_password), true);
  });
});
