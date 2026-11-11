import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, post, uniquePhone, phoneCode, makeUser } from "./helpers.js";

describe("send-phone-otp / verify-phone-otp", () => {
  before(startServer);
  after(stopServer);

  it("validates purpose, channel and phone length", async () => {
    assert.equal((await post("/functions/v1/send-phone-otp", { phone: "9000000000" })).status, 400);
    assert.equal((await post("/functions/v1/send-phone-otp", { phone: "9000000000", purpose: "x" })).status, 400);
    assert.equal((await post("/functions/v1/send-phone-otp", { phone: "9000000000", purpose: "login", channel: "fax" })).status, 400);
    assert.equal((await post("/functions/v1/send-phone-otp", { phone: "123", purpose: "login" })).status, 400);
  });

  it("login for an unknown phone returns 404; signup for a known phone returns 409", async () => {
    assert.equal((await post("/functions/v1/send-phone-otp", { phone: uniquePhone(), purpose: "login" })).status, 404);
    const u = await makeUser();
    assert.equal((await post("/functions/v1/send-phone-otp", { phone: u.phone, purpose: "signup" })).status, 409);
  });

  it("login round trip returns a session for the phone's owner", async () => {
    const u = await makeUser();
    assert.equal((await post("/functions/v1/send-phone-otp", { phone: u.phone, purpose: "login" })).status, 200);
    const r = await post("/functions/v1/verify-phone-otp", { phone: u.phone, otp_code: phoneCode(u.phone), purpose: "login" });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.id, u.id);
    assert.ok(r.body.session.access_token);
  });

  it("a reused phone code is rejected", async () => {
    const u = await makeUser();
    await post("/functions/v1/send-phone-otp", { phone: u.phone, purpose: "login" });
    const code = phoneCode(u.phone);
    await post("/functions/v1/verify-phone-otp", { phone: u.phone, otp_code: code, purpose: "login" });
    assert.equal((await post("/functions/v1/verify-phone-otp", { phone: u.phone, otp_code: code, purpose: "login" })).status, 400);
  });

  it("3 sends per 10 minutes, then 429", async () => {
    const u = await makeUser();
    for (let i = 0; i < 3; i++) assert.equal((await post("/functions/v1/send-phone-otp", { phone: u.phone, purpose: "login" })).status, 200);
    assert.equal((await post("/functions/v1/send-phone-otp", { phone: u.phone, purpose: "login" })).status, 429);
  });

  it("whatsapp channel is accepted (dry-run)", async () => {
    const u = await makeUser();
    const r = await post("/functions/v1/send-phone-otp", { phone: u.phone, purpose: "login", channel: "whatsapp" });
    assert.equal(r.status, 200);
    assert.equal(r.body.channel, "whatsapp");
  });

  it("wrong phone code returns 401 with remaining attempts", async () => {
    const u = await makeUser();
    await post("/functions/v1/send-phone-otp", { phone: u.phone, purpose: "login" });
    const real = phoneCode(u.phone);
    const wrong = real === "000000" ? "111111" : "000000";
    const r = await post("/functions/v1/verify-phone-otp", { phone: u.phone, otp_code: wrong, purpose: "login" });
    assert.equal(r.status, 401);
    assert.match(r.body.error, /2 attempt\(s\) remaining/);
  });
});
