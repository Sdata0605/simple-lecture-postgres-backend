// Break tests: hostile or malformed input, forged tokens, and parallel requests against the limits.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, base, post, call, uniqueEmail, emailCode, makeUser, q } from "./helpers.js";

const INJECTION = "' OR '1'='1' --";

describe("break tests", () => {
  before(startServer);
  after(stopServer);

  it("SQL injection in email and token fields is treated as data, never a 500", async () => {
    const paths = [
      ["/functions/v1/send-email-otp", { email: INJECTION, purpose: "login" }],
      ["/functions/v1/verify-email-otp", { email: INJECTION, otp_code: "123456", purpose: "login" }],
      ["/functions/v1/send-phone-otp", { phone: "9999999999' OR 1=1", purpose: "login" }],
      ["/functions/v1/verify-password-reset-otp", { email: INJECTION, otp_code: "123456" }],
      ["/functions/v1/reset-password-with-token", { reset_token: INJECTION, new_password: "Strong!1", user_id: INJECTION }],
      ["/auth/v1/token?grant_type=password", { email: INJECTION, password: INJECTION }],
    ];
    for (const [path, body] of paths) {
      const r = await post(path, body);
      assert.notEqual(r.status, 500, `${path} returned 500 for injection input`);
    }
    assert.equal((await q("SELECT count(*)::int n FROM auth.users"))[0].n > 0, true, "users table must still exist");
  });

  it("a user_id that is not a UUID gets SESSION_EXPIRED, not an internal error", async () => {
    const r = await post("/functions/v1/reset-password-with-token", { reset_token: "ab".repeat(32), new_password: "Strong!1", user_id: "not-a-uuid" });
    assert.equal(r.body.code, "SESSION_EXPIRED");
  });

  it("wrong JSON types are rejected with 400, not accepted", async () => {
    assert.equal((await post("/functions/v1/send-email-otp", { email: ["a@example.test"], purpose: "login" })).status, 400);
    assert.equal((await post("/functions/v1/send-email-otp", { email: 42, purpose: "login" })).status, 400);
    assert.equal((await post("/functions/v1/send-email-otp", { email: "a@example.test", purpose: ["login"] })).status, 400);
    assert.equal((await post("/functions/v1/send-phone-otp", { phone: { n: 1 }, purpose: "login" })).status, 400);
  });

  it("malformed JSON is rejected with 4xx", async () => {
    const r = await call("POST", "/functions/v1/send-email-otp", { raw: "{not json", headers: { "Content-Type": "application/json" } });
    assert.ok(r.status >= 400 && r.status < 500, `expected 4xx, got ${r.status}`);
  });

  it("an oversized body (over 1 MB) is refused with 413", async () => {
    const big = JSON.stringify({ email: "a".repeat(2 * 1024 * 1024), purpose: "login" });
    const r = await call("POST", "/functions/v1/send-email-otp", { raw: big, headers: { "Content-Type": "application/json" } });
    assert.equal(r.status, 413);
  });

  it("a token signed with alg=none is rejected", async () => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const forged = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "x", role: "authenticated", aud: "authenticated" })}.`;
    const r = await call("GET", "/auth/v1/user", { headers: { Authorization: `Bearer ${forged}` } });
    assert.equal(r.status, 401);
  });

  it("a token signed with the wrong secret is rejected", async () => {
    const jwt = (await import("jsonwebtoken")).default;
    const forged = jwt.sign({ sub: "x", role: "authenticated", aud: "authenticated" }, "not-the-secret");
    assert.equal((await call("GET", "/auth/v1/user", { headers: { Authorization: `Bearer ${forged}` } })).status, 401);
  });

  it("empty and missing refresh tokens are rejected", async () => {
    assert.equal((await post("/auth/v1/token?grant_type=refresh_token", { refresh_token: "" })).status, 400);
    assert.equal((await post("/auth/v1/token?grant_type=refresh_token", {})).status, 400);
  });

  it("parallel OTP sends cannot beat the 3-per-10-minutes limit", async () => {
    const u = await makeUser();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => post("/functions/v1/send-email-otp", { email: u.email, purpose: "login" }))
    );
    const sent = results.filter((r) => r.status === 200).length;
    assert.equal(sent, 3, `expected exactly 3 sends, got ${sent}`);
    const stored = (await q("SELECT count(*)::int n FROM public.email_otp_verifications WHERE email = $1", [u.email]))[0].n;
    assert.equal(stored, 3);
  });

  it("parallel wrong codes cannot exceed the 3-attempt lockout", async () => {
    const u = await makeUser();
    await post("/functions/v1/send-email-otp", { email: u.email, purpose: "login" });
    const real = emailCode(u.email);
    const wrong = real === "000000" ? "111111" : "000000";
    const results = await Promise.all(
      Array.from({ length: 8 }, () => post("/functions/v1/verify-email-otp", { email: u.email, otp_code: wrong, purpose: "login" }))
    );
    const wrongAnswers = results.filter((r) => r.status === 401).length;
    assert.ok(wrongAnswers <= 3, `more than 3 guesses were checked: ${wrongAnswers}`);
    const attempts = (await q("SELECT attempts FROM public.email_otp_verifications WHERE email = $1 ORDER BY created_at DESC LIMIT 1", [u.email]))[0].attempts;
    assert.ok(attempts <= 3, `attempts counter went past 3: ${attempts}`);
  });

  it("the server still answers health after all of the above", async () => {
    const r = await call("GET", "/health");
    assert.equal(r.status, 200);
    assert.equal(r.body.db, "simplelecture_test");
    assert.ok(base.startsWith("http://127.0.0.1:"));
  });
});
