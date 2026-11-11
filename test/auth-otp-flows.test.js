// Black-box QA of the auth and OTP flows over HTTP, plus checks on the system_logs rows each flow writes.
// Dry-run only: codes are read through the helpers (emailCode, phoneCode) and never printed.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, base, makeUser, uniqueEmail, uniquePhone, emailCode, phoneCode, q } from "./helpers.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Plain HTTP call that also returns the X-Request-Id header.
async function rq(method, path, { body, headers = {}, rawBody } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, reqId: res.headers.get("x-request-id") };
}
const POST = (path, body, headers) => rq("POST", path, { body, headers });
const GET = (path, headers) => rq("GET", path, { headers });
const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const wrongCodeFor = (code) => (code === "000000" ? "111111" : "000000");

// system_logs writes are fire-and-forget, so poll briefly until the wanted events appear.
async function logsFor(reqId, wanted = []) {
  let rows = [];
  for (let i = 0; i < 60; i++) {
    rows = await q(
      `SELECT category, event, outcome, status_code, masked_identifier, request_id
         FROM public.system_logs WHERE request_id = $1 ORDER BY id`,
      [reqId]
    );
    const have = new Set(rows.map((r) => r.event));
    if (wanted.every((e) => have.has(e))) break;
    await sleep(50);
  }
  return rows;
}
const findRow = (rows, category, event) => rows.find((r) => r.category === category && r.event === event);

// Masking as stored in system_logs (_shared/system-log.js maskIdentifier).
const logEmail = (e) => `${e[0]}***@${e.split("@")[1]}`;
const logPhone = (p) => "******" + p.slice(-4);

describe("auth and OTP flows (black-box)", () => {
  before(startServer);
  after(stopServer);

  // ---- 1. Signup
  it("1. signup with email and password returns a session and logs signup.requested", async () => {
    const email = uniqueEmail("s1");
    const r = await POST("/auth/v1/signup", { email, password: "Pass!word1", data: { full_name: "QA One", phone: uniquePhone() } });
    assert.equal(r.status, 200);
    assert.ok(r.body.access_token, "access token");
    assert.ok(r.body.refresh_token, "refresh token");
    assert.equal(r.body.user.email, email);
    const rows = await logsFor(r.reqId, ["signup.requested"]);
    const row = findRow(rows, "auth", "signup.requested");
    assert.ok(row, "auth signup.requested row");
    assert.equal(row.outcome, "info");
  });

  it("1. duplicate signup returns 422 user_already_exists and logs signup.failed with status 422", async () => {
    const u = await makeUser();
    const r = await POST("/auth/v1/signup", { email: u.email, password: "Pass!word1" });
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "user_already_exists");
    const rows = await logsFor(r.reqId, ["signup.failed"]);
    const row = findRow(rows, "auth", "signup.failed");
    assert.ok(row, "auth signup.failed row");
    assert.equal(row.outcome, "failed");
    assert.equal(row.status_code, 422, "signup.failed row must carry status_code 422");
  });

  // ---- 2-4. Password login
  it("2. right password returns 200 and logs login.success with the masked email", async () => {
    const u = await makeUser({ password: "Right!pass1" });
    const r = await POST("/auth/v1/token?grant_type=password", { email: u.email, password: "Right!pass1" });
    assert.equal(r.status, 200);
    assert.ok(r.body.access_token);
    const rows = await logsFor(r.reqId, ["login.success"]);
    const row = findRow(rows, "auth", "login.success");
    assert.ok(row, "auth login.success row");
    assert.equal(row.outcome, "success");
    assert.equal(row.masked_identifier, logEmail(u.email));
  });

  it("3. wrong password returns 400 invalid_grant, logs login.failed, and matches the unknown-email reply", async () => {
    const u = await makeUser({ password: "Right!pass1" });
    const wrong = await POST("/auth/v1/token?grant_type=password", { email: u.email, password: "Wrong!pass9" });
    const unknown = await POST("/auth/v1/token?grant_type=password", { email: uniqueEmail("nobody"), password: "Wrong!pass9" });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error, "invalid_grant");
    assert.deepEqual(wrong.body, unknown.body, "reply must not reveal whether the email exists");
    assert.equal(wrong.status, unknown.status);
    const rows = await logsFor(wrong.reqId, ["login.failed"]);
    const row = findRow(rows, "auth", "login.failed");
    assert.ok(row, "auth login.failed row");
    assert.equal(row.outcome, "failed");
    assert.equal(row.masked_identifier, logEmail(u.email));
  });

  it("4. unknown email returns the same 400 body and logs login.failed", async () => {
    const email = uniqueEmail("ghost");
    const r = await POST("/auth/v1/token?grant_type=password", { email, password: "Whatever!1" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_grant");
    assert.deepEqual(r.body, { error: "invalid_grant", error_description: "Invalid login credentials" });
    const rows = await logsFor(r.reqId, ["login.failed"]);
    const row = findRow(rows, "auth", "login.failed");
    assert.ok(row, "auth login.failed row for unknown email");
    assert.equal(row.outcome, "failed");
    assert.equal(row.masked_identifier, logEmail(email));
  });

  // ---- 5. Refresh rotation
  it("5. refresh rotates the token, the old one is rejected, and both outcomes are logged", async () => {
    const u = await makeUser();
    const r1 = await POST("/auth/v1/token?grant_type=refresh_token", { refresh_token: u.refresh });
    assert.equal(r1.status, 200);
    assert.ok(r1.body.access_token);
    assert.notEqual(r1.body.refresh_token, u.refresh, "refresh token must rotate");
    const rows1 = await logsFor(r1.reqId, ["refresh.success"]);
    assert.ok(findRow(rows1, "auth", "refresh.success"), "refresh.success row");

    const reuse = await POST("/auth/v1/token?grant_type=refresh_token", { refresh_token: u.refresh });
    assert.equal(reuse.status, 400);
    assert.equal(reuse.body.error, "invalid_grant");
    const rows2 = await logsFor(reuse.reqId, ["refresh.failed"]);
    const failed = findRow(rows2, "auth", "refresh.failed");
    assert.ok(failed, "refresh.failed row");
    assert.equal(failed.outcome, "failed");

    const fresh = await POST("/auth/v1/token?grant_type=refresh_token", { refresh_token: r1.body.refresh_token });
    assert.equal(fresh.status, 200, "the new refresh token must still work");
  });

  // ---- 6. Logout
  it("6. logout returns 204 and logs the logout event; the refresh token stops working", async () => {
    const u = await makeUser();
    const r = await POST("/auth/v1/logout", { refresh_token: u.refresh });
    assert.ok([200, 204].includes(r.status), `logout status ${r.status}`);
    const rows = await logsFor(r.reqId, ["logout"]);
    const row = findRow(rows, "auth", "logout");
    assert.ok(row, "auth logout row");
    const after = await POST("/auth/v1/token?grant_type=refresh_token", { refresh_token: u.refresh });
    assert.equal(after.status, 400, "refresh token must be dead after logout");
  });

  it("6. access token is rejected by GET /auth/v1/user after logout (expected to fail until sessions are revoked)", async () => {
    const u = await makeUser();
    const before = await GET("/auth/v1/user", bearer(u.access));
    assert.equal(before.status, 200);
    await POST("/auth/v1/logout", { refresh_token: u.refresh });
    const after = await GET("/auth/v1/user", bearer(u.access));
    assert.equal(after.status, 401, `GET /auth/v1/user after logout returned ${after.status}`);
  });

  // ---- 7. Email OTP login
  it("7. email OTP login: send returns masked email; wrong code 401 is logged; right code issues a session", async () => {
    const u = await makeUser();
    const send = await POST("/functions/v1/send-email-otp", { email: u.email, purpose: "login" });
    assert.equal(send.status, 200);
    assert.equal(send.body.success, true);
    assert.notEqual(send.body.email, u.email, "reply must not echo the full address");
    assert.equal(send.body.email, `${u.email.slice(0, 2)}***@${u.email.split("@")[1]}`);
    const sendRows = await logsFor(send.reqId, ["otp.requested", "otp.sent"]);
    assert.ok(findRow(sendRows, "otp.email", "otp.requested"), "otp.requested row");
    assert.ok(findRow(sendRows, "otp.email", "otp.sent"), "otp.sent row");

    const code = emailCode(u.email);
    assert.match(code || "", /^\d{6}$/, "dry-run mail must carry a code");

    // The spec expected 400 here. The port (and test/email-otp.test.js) returns 401 for a wrong code.
    const wrong = await POST("/functions/v1/verify-email-otp", { email: u.email, otp_code: wrongCodeFor(code), purpose: "login" });
    assert.equal(wrong.status, 401);
    assert.match(wrong.body.error, /^Incorrect OTP/);
    const wrongRows = await logsFor(wrong.reqId, ["otp.wrong_code"]);
    const wrongRow = findRow(wrongRows, "otp.email", "otp.wrong_code");
    assert.ok(wrongRow, "otp.wrong_code row");
    assert.equal(wrongRow.outcome, "failed");

    const ok = await POST("/functions/v1/verify-email-otp", { email: u.email, otp_code: code, purpose: "login" });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.session?.access_token, "session returned");
    assert.ok(ok.body.session?.refresh_token, "refresh token returned");
    const okRows = await logsFor(ok.reqId, ["otp.verified", "otp.session_issued"]);
    assert.ok(findRow(okRows, "otp.email", "otp.verified"), "otp.verified row");
    assert.ok(findRow(okRows, "otp.email", "otp.session_issued"), "otp.session_issued row");
  });

  it("7. email OTP rate limit: the 4th send within 10 minutes returns 429 and logs otp.rejected", async () => {
    const u = await makeUser();
    for (let i = 0; i < 3; i++) {
      const r = await POST("/functions/v1/send-email-otp", { email: u.email, purpose: "login" });
      assert.equal(r.status, 200, `send ${i + 1}`);
    }
    const r = await POST("/functions/v1/send-email-otp", { email: u.email, purpose: "login" });
    assert.equal(r.status, 429);
    const rows = await logsFor(r.reqId, ["otp.rejected"]);
    const row = findRow(rows, "otp.email", "otp.rejected");
    assert.ok(row, "otp.rejected row");
    assert.equal(row.outcome, "failed");
    assert.equal(row.status_code, 429);
  });

  // ---- 8. Email OTP signup
  it("8. email OTP signup: verify with name and phone creates the account and issues a session", async () => {
    const email = uniqueEmail("eotp");
    const phone = uniquePhone();
    const send = await POST("/functions/v1/send-email-otp", { email, purpose: "signup" });
    assert.equal(send.status, 200);
    const code = emailCode(email);
    assert.match(code || "", /^\d{6}$/);

    const ver = await POST("/functions/v1/verify-email-otp", {
      email,
      otp_code: code,
      purpose: "signup",
      signup_data: { full_name: "Email Signup", phone },
    });
    assert.equal(ver.status, 200);
    assert.ok(ver.body.session?.access_token, "session returned");
    assert.equal(ver.body.user.email, email);
    const profile = await q("SELECT full_name, phone_number FROM public.profiles WHERE email = $1", [email]);
    assert.equal(profile.length, 1, "profile created");
    assert.equal(profile[0].phone_number, phone);
    const users = await q("SELECT count(*)::int n FROM auth.users WHERE email = $1", [email]);
    assert.equal(users[0].n, 1, "auth user created");
    const rows = await logsFor(ver.reqId, ["otp.session_issued"]);
    assert.ok(findRow(rows, "otp.email", "otp.session_issued"), "otp.session_issued row");
  });

  // ---- 9. Phone OTP over SMS (dry-run)
  it("9. phone OTP over SMS: send, wrong code 401, right code session, all under otp.sms", async () => {
    const u = await makeUser();
    const send = await POST("/functions/v1/send-phone-otp", { phone: u.phone, purpose: "login", channel: "sms" });
    assert.equal(send.status, 200);
    assert.equal(send.body.channel, "sms");
    const sendRows = await logsFor(send.reqId, ["otp.requested", "otp.sent"]);
    const requested = findRow(sendRows, "otp.sms", "otp.requested");
    assert.ok(requested, "otp.sms otp.requested row");
    assert.equal(requested.masked_identifier, logPhone(u.phone));
    assert.ok(findRow(sendRows, "otp.sms", "otp.sent"), "otp.sms otp.sent row");

    const code = phoneCode(u.phone);
    assert.match(code || "", /^\d{6}$/);
    const wrong = await POST("/functions/v1/verify-phone-otp", { phone: u.phone, otp_code: wrongCodeFor(code), purpose: "login" });
    assert.equal(wrong.status, 401);
    const wrongRows = await logsFor(wrong.reqId, ["otp.wrong_code"]);
    assert.ok(findRow(wrongRows, "otp.sms", "otp.wrong_code"), "otp.sms otp.wrong_code row");

    const ok = await POST("/functions/v1/verify-phone-otp", { phone: u.phone, otp_code: code, purpose: "login" });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.session?.access_token);
    const okRows = await logsFor(ok.reqId, ["otp.verified", "otp.session_issued"]);
    assert.ok(findRow(okRows, "otp.sms", "otp.verified"), "otp.sms otp.verified row");
    assert.ok(findRow(okRows, "otp.sms", "otp.session_issued"), "otp.sms otp.session_issued row");
  });

  // ---- 10. WhatsApp OTP (dry-run)
  it("10. WhatsApp OTP: the send is recorded with channel whatsapp and the code verifies", async () => {
    const u = await makeUser();
    const send = await POST("/functions/v1/send-phone-otp", { phone: u.phone, purpose: "login", channel: "whatsapp" });
    assert.equal(send.status, 200);
    assert.equal(send.body.channel, "whatsapp");
    const dbRows = await q("SELECT channel FROM public.phone_otp_verifications WHERE phone_number = $1 ORDER BY created_at DESC LIMIT 1", [u.phone]);
    assert.equal(dbRows[0]?.channel, "whatsapp", "OTP row stores channel whatsapp");
    const code = phoneCode(u.phone);
    const wrong = await POST("/functions/v1/verify-phone-otp", { phone: u.phone, otp_code: wrongCodeFor(code), purpose: "login" });
    assert.equal(wrong.status, 401);
    const wrongRows = await logsFor(wrong.reqId, ["otp.wrong_code"]);
    assert.ok(
      wrongRows.some((r) => r.category === "otp.whatsapp" && r.event === "otp.wrong_code"),
      "WhatsApp wrong-code row must be under otp.whatsapp"
    );
    const ok = await POST("/functions/v1/verify-phone-otp", { phone: u.phone, otp_code: code, purpose: "login" });
    assert.equal(ok.status, 200);
    const okRows = await logsFor(ok.reqId, ["otp.session_issued"]);
    assert.ok(
      okRows.some((r) => r.category === "otp.whatsapp" && r.event === "otp.session_issued"),
      "WhatsApp session row must be under otp.whatsapp"
    );
  });

  it("10. WhatsApp OTP: send logs under category otp.whatsapp (BUG: currently logged as otp.sms)", async () => {
    const u = await makeUser();
    const send = await POST("/functions/v1/send-phone-otp", { phone: u.phone, purpose: "login", channel: "whatsapp" });
    assert.equal(send.status, 200);
    const rows = await logsFor(send.reqId, ["otp.sent"]);
    assert.ok(
      rows.some((r) => r.category === "otp.whatsapp" && r.event === "otp.sent"),
      `expected an otp.whatsapp otp.sent row; categories seen: ${[...new Set(rows.map((r) => r.category))].join(",") || "none"}`
    );
  });

  // ---- 11. Password reset
  it("11. password reset: send, verify, reset with token; new password works, old one fails", async () => {
    const u = await makeUser({ password: "OldPass!1" });
    const send = await POST("/functions/v1/send-password-reset-otp", { email: u.email });
    assert.equal(send.status, 200);
    assert.ok(send.body.message, "generic reply");
    const rowsSend = await logsFor(send.reqId, ["password_reset.requested"]);
    assert.ok(findRow(rowsSend, "auth", "password_reset.requested"), "password_reset.requested row");

    const code = emailCode(u.email);
    assert.match(code || "", /^\d{6}$/);
    const wrong = await POST("/functions/v1/verify-password-reset-otp", { email: u.email, otp_code: wrongCodeFor(code) });
    assert.equal(wrong.status, 200);
    assert.equal(wrong.body.code, "INVALID_OTP");
    const wrongRows = await logsFor(wrong.reqId, ["password_reset.wrong_code"]);
    assert.ok(findRow(wrongRows, "auth", "password_reset.wrong_code"), "password_reset.wrong_code row");

    const ver = await POST("/functions/v1/verify-password-reset-otp", { email: u.email, otp_code: code });
    assert.equal(ver.status, 200);
    assert.ok(ver.body.reset_token, "reset token returned");
    assert.equal(ver.body.user_id, u.id);

    const reset = await POST("/functions/v1/reset-password-with-token", {
      reset_token: ver.body.reset_token,
      new_password: "NewPass!2",
      user_id: u.id,
    });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.message, "Password reset successfully");
    const rowsReset = await logsFor(reset.reqId, ["password_reset.token_valid"]);
    assert.ok(findRow(rowsReset, "auth", "password_reset.token_valid"), "password_reset.token_valid row");

    const newLogin = await POST("/auth/v1/token?grant_type=password", { email: u.email, password: "NewPass!2" });
    assert.equal(newLogin.status, 200, "new password logs in");
    const oldLogin = await POST("/auth/v1/token?grant_type=password", { email: u.email, password: "OldPass!1" });
    assert.equal(oldLogin.status, 400, "old password is rejected");

    const replay = await POST("/functions/v1/reset-password-with-token", {
      reset_token: ver.body.reset_token,
      new_password: "Third!3",
      user_id: u.id,
    });
    assert.equal(replay.body.code, "SESSION_EXPIRED", "reset token cannot be reused");
  });

  // ---- 12. Failure paths: never 500
  it("12. malformed JSON body returns 400 and never 500", async () => {
    const r = await rq("POST", "/auth/v1/signup", { rawBody: "{not json", headers: { "Content-Type": "application/json" } });
    assert.equal(r.status, 400);
    assert.ok(r.reqId, "X-Request-Id still set on a parse error");
  });

  it("12. missing fields and wrong types return 400 on the hard endpoints", async () => {
    const cases = [
      ["/functions/v1/send-email-otp", {}],
      ["/functions/v1/verify-email-otp", {}],
      ["/functions/v1/send-phone-otp", {}],
      ["/functions/v1/verify-phone-otp", {}],
      ["/auth/v1/signup", {}],
      ["/auth/v1/signup", { email: "a@example.test" }],
      ["/functions/v1/send-email-otp", { email: 123, purpose: "login" }],
      ["/functions/v1/send-email-otp", { email: ["a@example.test"], purpose: "login" }],
      ["/functions/v1/send-email-otp", { email: "a@example.test", purpose: ["login"] }],
      ["/functions/v1/send-phone-otp", { phone: 9123456789, purpose: "login" }],
      ["/functions/v1/send-phone-otp", { phone: { n: 1 }, purpose: "login" }],
      ["/functions/v1/verify-phone-otp", { phone: {}, otp_code: "123456", purpose: "login" }],
    ];
    for (const [path, body] of cases) {
      const r = await POST(path, body);
      assert.equal(r.status, 400, `${path} ${JSON.stringify(Object.keys(body))} returned ${r.status}`);
    }
    const loginEmpty = await POST("/auth/v1/token?grant_type=password", {});
    assert.equal(loginEmpty.status, 400);
  });

  it("12. long, spaced and SQL-looking emails are rejected with 400, and no account is created", async () => {
    const usersBefore = (await q("SELECT count(*)::int n FROM auth.users"))[0].n;
    const tag = Date.now().toString(36); // unique per run, so rows from earlier runs cannot interfere
    const bad = [
      "a".repeat(240) + tag + "@example.test", // over 254 characters
      "a b" + tag + "@example.test", // space
      "x'; DROP TABLE auth.users;--" + tag + "@example.test", // SQL-looking, with spaces
    ];
    for (const email of bad) {
      const send = await POST("/functions/v1/send-email-otp", { email, purpose: "signup" });
      assert.equal(send.status, 400, `send-email-otp accepted an invalid email (status ${send.status})`);
      const ver = await POST("/functions/v1/verify-email-otp", { email, otp_code: "123456", purpose: "signup", signup_data: { full_name: "X", phone: uniquePhone() } });
      assert.equal(ver.status, 400, `verify-email-otp status ${ver.status}`);
      const sign = await POST("/auth/v1/signup", { email, password: "Pass!word1" });
      assert.equal(sign.status, 400, `signup accepted an invalid email (status ${sign.status})`);
      const login = await POST("/auth/v1/token?grant_type=password", { email, password: "Pass!word1" });
      assert.equal(login.status, 400);
    }
    const usersAfter = (await q("SELECT count(*)::int n FROM auth.users"))[0].n;
    assert.equal(usersAfter, usersBefore, "no account created from invalid emails");
  });

  it("12. unicode email is rejected with 400 on every endpoint (expected to fail: format policy)", async () => {
    const email = "tést." + Date.now().toString(36) + "@exämple.test";
    const send = await POST("/functions/v1/send-email-otp", { email, purpose: "signup" });
    assert.equal(send.status, 400, `send-email-otp accepted a unicode email (status ${send.status})`);
    const sign = await POST("/auth/v1/signup", { email, password: "Pass!word1" });
    assert.equal(sign.status, 400, `signup accepted a unicode email (status ${sign.status})`);
  });

  it("12. SQL-looking input without spaces is never a 500 and does not touch the tables", async () => {
    const sqlish = "x'--@example.test";
    const r = await POST("/functions/v1/send-email-otp", { email: sqlish, purpose: "login" });
    assert.notEqual(r.status, 500);
    const login = await POST("/auth/v1/token?grant_type=password", { email: "' OR 1=1 --", password: "x" });
    assert.equal(login.status, 400);
    const usersAfter = (await q("SELECT count(*)::int n FROM auth.users WHERE email = $1", [sqlish]))[0].n;
    assert.equal(usersAfter, 0, "SQL-looking email must not create an account");
  });

  it("12. reset-password endpoints answer with their soft error codes and never 500", async () => {
    const a = await POST("/functions/v1/send-password-reset-otp", {});
    assert.equal(a.status, 200);
    assert.equal(a.body.code, "INVALID_EMAIL");
    const b = await POST("/functions/v1/verify-password-reset-otp", { email: "a@example.test" });
    assert.equal(b.status, 200);
    assert.equal(b.body.code, "INVALID_OTP");
    const c = await POST("/functions/v1/reset-password-with-token", { reset_token: "x", new_password: "Pass!word1", user_id: "not-a-uuid" });
    assert.equal(c.status, 200);
    assert.equal(c.body.code, "SESSION_EXPIRED");
  });

  // ---- 13. Concurrency
  it("13. six parallel email sends: at most 3 succeed, rows never exceed 3, the rest get 429", async () => {
    const email = uniqueEmail("race");
    const results = await Promise.all(
      Array.from({ length: 6 }, () => POST("/functions/v1/send-email-otp", { email, purpose: "signup" }))
    );
    const ok = results.filter((r) => r.status === 200).length;
    const limited = results.filter((r) => r.status === 429).length;
    assert.ok(ok <= 3, `${ok} sends succeeded`);
    assert.equal(ok + limited, 6, "every reply is 200 or 429");
    assert.ok(limited >= 3, "rate limit applied to the rest");
    const rows = (await q("SELECT count(*)::int n FROM public.email_otp_verifications WHERE email = $1 AND created_at >= now() - interval '10 minutes'", [email]))[0].n;
    assert.equal(rows, ok, "one row per successful send");
    assert.ok(rows <= 3);
  });

  it("13. six parallel phone sends: at most 3 rows in 10 minutes", async () => {
    const phone = uniquePhone();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => POST("/functions/v1/send-phone-otp", { phone, purpose: "signup", channel: "sms" }))
    );
    const ok = results.filter((r) => r.status === 200).length;
    assert.ok(ok <= 3, `${ok} phone sends succeeded`);
    const rows = (await q("SELECT count(*)::int n FROM public.phone_otp_verifications WHERE phone_number = $1 AND created_at >= now() - interval '10 minutes'", [phone]))[0].n;
    assert.equal(rows, ok);
  });

  // ---- 14. Request IDs
  it("14. every response in the flows carries X-Request-Id, and log rows share the request's id", async () => {
    const u = await makeUser({ password: "Right!pass1" });
    const ids = [];
    const login = await POST("/auth/v1/token?grant_type=password", { email: u.email, password: "Right!pass1" });
    ids.push(login.reqId);
    const refresh = await POST("/auth/v1/token?grant_type=refresh_token", { refresh_token: login.body.refresh_token });
    ids.push(refresh.reqId);
    const user = await GET("/auth/v1/user", bearer(refresh.body.access_token));
    ids.push(user.reqId);
    const sendEmail = await POST("/functions/v1/send-email-otp", { email: u.email, purpose: "login" });
    ids.push(sendEmail.reqId);
    const sendPhone = await POST("/functions/v1/send-phone-otp", { phone: u.phone, purpose: "login", channel: "sms" });
    ids.push(sendPhone.reqId);
    const sendReset = await POST("/functions/v1/send-password-reset-otp", { email: u.email });
    ids.push(sendReset.reqId);
    const logout = await POST("/auth/v1/logout", { refresh_token: refresh.body.refresh_token });
    ids.push(logout.reqId);

    for (const id of ids) assert.match(id || "", /^[0-9a-f]{12}$/, "X-Request-Id header");
    assert.equal(new Set(ids).size, ids.length, "each request gets its own id");

    const loginRows = await logsFor(login.reqId, ["login.success", "session.issued"]);
    assert.ok(findRow(loginRows, "auth", "login.success"), "login row carries the request id");
    const httpRows = loginRows.filter((r) => r.category === "http");
    assert.equal(httpRows.length, 1, "one http row per request");

    const sendRows = await logsFor(sendEmail.reqId, ["otp.requested", "otp.sent"]);
    assert.ok(findRow(sendRows, "otp.email", "otp.sent"), "email OTP rows share the request id");
    assert.ok(sendRows.every((r) => r.request_id === sendEmail.reqId), "all rows share the request id");
  });
});
