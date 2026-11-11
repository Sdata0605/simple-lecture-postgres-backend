import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, post, uniqueEmail, emailCode, makeUser, q } from "./helpers.js";

const randomPhone = () => "9" + String(Math.floor(100000000 + Math.random() * 899999999));

describe("send-email-otp / verify-email-otp", () => {
  before(startServer);
  after(stopServer);

  it("rejects missing fields, bad purpose and bad email", async () => {
    assert.equal((await post("/functions/v1/send-email-otp", { email: "a@example.test" })).status, 400);
    assert.equal((await post("/functions/v1/send-email-otp", { email: "a@example.test", purpose: "delete" })).status, 400);
    assert.equal((await post("/functions/v1/send-email-otp", { email: "not-an-email", purpose: "login" })).status, 400);
  });

  it("login for an unknown email returns 404", async () => {
    const r = await post("/functions/v1/send-email-otp", { email: uniqueEmail("nobody"), purpose: "login" });
    assert.equal(r.status, 404);
  });

  it("signup for an existing email returns 409", async () => {
    const u = await makeUser();
    const r = await post("/functions/v1/send-email-otp", { email: u.email, purpose: "signup" });
    assert.equal(r.status, 409);
  });

  it("sends a code for signup and masks the address in the reply", async () => {
    const email = uniqueEmail("new");
    const r = await post("/functions/v1/send-email-otp", { email, purpose: "signup" });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.notEqual(r.body.email, email, "reply must not echo the full address");
    assert.match(emailCode(email), /^\d{6}$/);
  });

  it("allows 3 OTPs per 10 minutes and blocks the 4th with 429", async () => {
    const u = await makeUser();
    for (let i = 0; i < 3; i++) {
      assert.equal((await post("/functions/v1/send-email-otp", { email: u.email, purpose: "login" })).status, 200);
    }
    assert.equal((await post("/functions/v1/send-email-otp", { email: u.email, purpose: "login" })).status, 429);
  });

  it("login verify: correct code returns a session; the same code cannot be used twice", async () => {
    const u = await makeUser();
    await post("/functions/v1/send-email-otp", { email: u.email, purpose: "login" });
    const code = emailCode(u.email);
    const ok = await post("/functions/v1/verify-email-otp", { email: u.email, otp_code: code, purpose: "login" });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.session.access_token);
    assert.ok(ok.body.session.refresh_token);
    assert.equal(ok.body.user.id, u.id);
    const again = await post("/functions/v1/verify-email-otp", { email: u.email, otp_code: code, purpose: "login" });
    assert.equal(again.status, 400);
  });

  it("wrong code returns 401 with remaining attempts; three wrong codes lock the OTP", async () => {
    const u = await makeUser();
    await post("/functions/v1/send-email-otp", { email: u.email, purpose: "login" });
    const real = emailCode(u.email);
    const wrong = real === "000000" ? "111111" : "000000";
    const first = await post("/functions/v1/verify-email-otp", { email: u.email, otp_code: wrong, purpose: "login" });
    assert.equal(first.status, 401);
    assert.match(first.body.error, /2 attempt\(s\) remaining/);
    await post("/functions/v1/verify-email-otp", { email: u.email, otp_code: wrong, purpose: "login" });
    await post("/functions/v1/verify-email-otp", { email: u.email, otp_code: wrong, purpose: "login" });
    const locked = await post("/functions/v1/verify-email-otp", { email: u.email, otp_code: real, purpose: "login" });
    assert.equal(locked.status, 429, "the correct code must not work after three wrong attempts");
  });

  it("an expired code is rejected", async () => {
    const u = await makeUser();
    await post("/functions/v1/send-email-otp", { email: u.email, purpose: "login" });
    await q("UPDATE public.email_otp_verifications SET expires_at = now() - interval '1 minute' WHERE email = $1", [u.email]);
    const r = await post("/functions/v1/verify-email-otp", { email: u.email, otp_code: emailCode(u.email), purpose: "login" });
    assert.equal(r.status, 400);
  });

  it("signup verify requires name and phone", async () => {
    const email = uniqueEmail("sx");
    await post("/functions/v1/send-email-otp", { email, purpose: "signup" });
    const r = await post("/functions/v1/verify-email-otp", { email, otp_code: emailCode(email), purpose: "signup", signup_data: { phone: "9000000000" } });
    assert.equal(r.status, 400);
  });

  it("signup verify creates the account, profile and student role, and returns a session", async () => {
    const email = uniqueEmail("sv");
    const phone = randomPhone();
    await post("/functions/v1/send-email-otp", { email, purpose: "signup" });
    const r = await post("/functions/v1/verify-email-otp", {
      email, otp_code: emailCode(email), purpose: "signup", signup_data: { full_name: "Signup Tester", phone },
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.session.access_token);
    const prof = await q("SELECT full_name, phone_number FROM public.profiles WHERE email = $1", [email]);
    assert.equal(prof.length, 1);
    assert.equal(prof[0].full_name, "Signup Tester");
    assert.equal(prof[0].phone_number, phone);
    const role = await q("SELECT ur.role FROM public.user_roles ur JOIN auth.users u ON u.id = ur.user_id WHERE u.email = $1", [email]);
    assert.equal(role[0].role, "student");
  });

  it("a phone already in use blocks signup before the code is used, so a corrected retry still works", async () => {
    const taken = await makeUser();
    const email = uniqueEmail("retry");
    await post("/functions/v1/send-email-otp", { email, purpose: "signup" });
    const code = emailCode(email);
    const blocked = await post("/functions/v1/verify-email-otp", {
      email, otp_code: code, purpose: "signup", signup_data: { full_name: "Retry", phone: taken.phone },
    });
    assert.equal(blocked.status, 409);
    const fixed = await post("/functions/v1/verify-email-otp", {
      email, otp_code: code, purpose: "signup", signup_data: { full_name: "Retry", phone: randomPhone() },
    });
    assert.equal(fixed.status, 200, "the code must still be valid after the pre-flight rejection");
  });
});
