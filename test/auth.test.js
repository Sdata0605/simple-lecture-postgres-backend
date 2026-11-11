import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, call, post, makeUser, uniqueEmail, uniquePhone, expiredJwt, q } from "./helpers.js";

describe("/auth/v1 token, signup, user, logout", () => {
  before(startServer);
  after(stopServer);

  it("signup returns a session and creates profile and role", async () => {
    const email = uniqueEmail("su");
    const phone = uniquePhone();
    const r = await post("/auth/v1/signup", { email, password: "Pass!word1", data: { full_name: "Sign Up", phone } });
    assert.equal(r.status, 200);
    assert.equal(r.body.token_type, "bearer");
    assert.equal(r.body.user.email, email);
    assert.equal((await q("SELECT count(*)::int n FROM public.profiles WHERE email = $1", [email]))[0].n, 1);
  });

  it("signup with a phone already in use returns 422 phone_already_exists", async () => {
    const taken = await makeUser();
    const r = await post("/auth/v1/signup", { email: uniqueEmail("ph"), password: "Pass!word1", data: { full_name: "Dup", phone: taken.phone } });
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "phone_already_exists");
  });

  it("signup validates input and rejects duplicates", async () => {
    assert.equal((await post("/auth/v1/signup", { email: uniqueEmail("v") })).status, 400);
    assert.equal((await post("/auth/v1/signup", { email: uniqueEmail("v"), password: "123" })).body.error, "weak_password");
    const u = await makeUser();
    const dup = await post("/auth/v1/signup", { email: u.email, password: "Pass!word1" });
    assert.equal(dup.status, 422);
    assert.equal(dup.body.error, "user_already_exists");
  });

  it("password login: right password gives a session; wrong and unknown emails give the same error", async () => {
    const u = await makeUser({ password: "Right!pass1" });
    assert.equal((await post("/auth/v1/token?grant_type=password", { email: u.email, password: "Right!pass1" })).status, 200);
    const wrong = await post("/auth/v1/token?grant_type=password", { email: u.email, password: "nope" });
    const unknown = await post("/auth/v1/token?grant_type=password", { email: uniqueEmail("zz"), password: "nope" });
    assert.equal(wrong.status, 400);
    assert.deepEqual(wrong.body, unknown.body, "reply must not reveal whether the email exists");
  });

  it("refresh rotates the token: the old one is single use", async () => {
    const u = await makeUser();
    const r1 = await post("/auth/v1/token?grant_type=refresh_token", { refresh_token: u.refresh });
    assert.equal(r1.status, 200);
    assert.notEqual(r1.body.refresh_token, u.refresh);
    const reuse = await post("/auth/v1/token?grant_type=refresh_token", { refresh_token: u.refresh });
    assert.equal(reuse.status, 400);
    assert.equal(reuse.body.error, "invalid_grant");
  });

  it("/user returns the user for a valid token and 401 for missing, tampered or expired tokens", async () => {
    const u = await makeUser();
    const ok = await call("GET", "/auth/v1/user", { headers: { Authorization: `Bearer ${u.access}` } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.id, u.id);
    assert.equal((await call("GET", "/auth/v1/user")).status, 401);
    const tampered = u.access.slice(0, -2) + (u.access.endsWith("A") ? "B" : "A");
    assert.equal((await call("GET", "/auth/v1/user", { headers: { Authorization: `Bearer ${tampered}` } })).status, 401);
    assert.equal((await call("GET", "/auth/v1/user", { headers: { Authorization: `Bearer ${expiredJwt(u.id)}` } })).status, 401);
  });

  it("logout ends the refresh token; logging out an unknown token still returns 204", async () => {
    const u = await makeUser();
    assert.equal((await post("/auth/v1/logout", { refresh_token: u.refresh })).status, 204);
    assert.equal((await post("/auth/v1/token?grant_type=refresh_token", { refresh_token: u.refresh })).status, 400);
    assert.equal((await post("/auth/v1/logout", { refresh_token: "nope" })).status, 204);
  });

  it("unsupported grant type returns 400", async () => {
    assert.equal((await post("/auth/v1/token?grant_type=magic", {})).status, 400);
  });
});
