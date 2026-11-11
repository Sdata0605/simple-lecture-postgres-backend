import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { startServer, stopServer, base, makeUser, q } from "./helpers.js";

const rpc = (fn, body, headers) =>
  fetch(`${base}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: "anon-placeholder", "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

describe("rest: admin-only scan_* RPC", () => {
  let admin;
  let student;
  before(async () => {
    await startServer();
    admin = await makeUser();
    student = await makeUser();
    await q("INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING", [admin.id]);
  });
  after(async () => {
    await q("DELETE FROM public.user_roles WHERE user_id = $1 AND role = 'admin'", [admin.id]);
    await stopServer();
  });

  it("an admin can call scan_video_generation_coverage", async () => {
    const r = await rpc("scan_video_generation_coverage", {}, { Authorization: `Bearer ${admin.access}` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body));
  });

  it("a student gets the function's own forbidden error, not a permission bounce", async () => {
    const r = await rpc("scan_video_generation_coverage", {}, { Authorization: `Bearer ${student.access}` });
    assert.notEqual(r.status, 200);
    assert.match(JSON.stringify(r.body), /forbidden/);
  });

  it("an anonymous caller cannot call it", async () => {
    const r = await rpc("scan_video_generation_coverage", {}, {});
    assert.notEqual(r.status, 200);
  });

  it("worker claim_* functions stay closed to signed-in users", async () => {
    const r = await rpc("claim_auto_submission_run", {}, { Authorization: `Bearer ${admin.access}` });
    assert.notEqual(r.status, 200);
  });
});
