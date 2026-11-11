import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { startServer, stopServer, post, uniqueEmail, emailCode, makeUser, q } from "./helpers.js";

describe("password reset: send, verify, reset", () => {
  before(startServer);
  after(stopServer);

  it("unknown email gets the same generic reply and no code is stored", async () => {
    const email = uniqueEmail("ghost");
    const r = await post("/functions/v1/send-password-reset-otp", { email });
    assert.equal(r.status, 200);
    assert.match(r.body.message, /If an account exists/);
    assert.equal(emailCode(email), null);
  });

  it("invalid email is rejected with INVALID_EMAIL", async () => {
    const r = await post("/functions/v1/send-password-reset-otp", { email: "nope" });
    assert.equal(r.body.code, "INVALID_EMAIL");
  });

  it("full reset: send, verify, reset; the new password works and the old one does not", async () => {
    const u = await makeUser({ password: "OldPass!1" });
    assert.match((await post("/functions/v1/send-password-reset-otp", { email: u.email })).body.message, /If an account exists/);
    const v = await post("/functions/v1/verify-password-reset-otp", { email: u.email, otp_code: emailCode(u.email) });
    assert.equal(v.status, 200);
    assert.match(v.body.reset_token, /^[0-9a-f]{64}$/);
    const reset = await post("/functions/v1/reset-password-with-token", { reset_token: v.body.reset_token, new_password: "NewPass!2", user_id: u.id });
    assert.equal(reset.body.message, "Password reset successfully");
    const rows = await q("SELECT encrypted_password FROM auth.users WHERE id = $1", [u.id]);
    assert.equal(await bcrypt.compare("NewPass!2", rows[0].encrypted_password), true);
    assert.equal(await bcrypt.compare("OldPass!1", rows[0].encrypted_password), false);
    assert.equal((await post("/auth/v1/token?grant_type=password", { email: u.email, password: "NewPass!2" })).status, 200);
    assert.equal((await post("/auth/v1/token?grant_type=password", { email: u.email, password: "OldPass!1" })).status, 400);
  });

  it("wrong reset code returns INVALID_OTP with the remaining count", async () => {
    const u = await makeUser();
    await post("/functions/v1/send-password-reset-otp", { email: u.email });
    const real = emailCode(u.email);
    const wrong = real === "000000" ? "111111" : "000000";
    const r = await post("/functions/v1/verify-password-reset-otp", { email: u.email, otp_code: wrong });
    assert.equal(r.body.code, "INVALID_OTP");
    assert.match(r.body.error, /4 attempts remaining/);
  });

  it("five wrong codes lock the reset OTP; the correct code then gives no token", async () => {
    const u = await makeUser();
    await post("/functions/v1/send-password-reset-otp", { email: u.email });
    const real = emailCode(u.email);
    const wrong = real === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await post("/functions/v1/verify-password-reset-otp", { email: u.email, otp_code: wrong });
    const r = await post("/functions/v1/verify-password-reset-otp", { email: u.email, otp_code: real });
    assert.equal(r.body.reset_token, undefined, "correct code must not work after lockout");
  });

  it("reset with a bad token returns SESSION_EXPIRED; a weak password returns WEAK_PASSWORD", async () => {
    const u = await makeUser();
    assert.equal((await post("/functions/v1/reset-password-with-token", { reset_token: "ab".repeat(32), new_password: "Strong!1", user_id: u.id })).body.code, "SESSION_EXPIRED");
    assert.equal((await post("/functions/v1/reset-password-with-token", { reset_token: "ab", new_password: "123", user_id: u.id })).body.code, "WEAK_PASSWORD");
  });

  it("an old reset token (over 10 minutes) is rejected", async () => {
    const u = await makeUser();
    await post("/functions/v1/send-password-reset-otp", { email: u.email });
    const v = await post("/functions/v1/verify-password-reset-otp", { email: u.email, otp_code: emailCode(u.email) });
    await q("UPDATE public.password_reset_otps SET created_at = now() - interval '11 minutes' WHERE user_id = $1", [u.id]);
    const r = await post("/functions/v1/reset-password-with-token", { reset_token: v.body.reset_token, new_password: "Strong!1", user_id: u.id });
    assert.equal(r.body.code, "SESSION_EXPIRED");
  });
});
