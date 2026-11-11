import "dotenv/config";
process.env.MAIL_MODE = "dry-run";
process.env.MESSAGE_MODE = "dry-run";
import crypto from "node:crypto";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, uniqueEmail, uniquePhone, emailCode, phoneCode, q, base } from "./helpers.js";
import {
  maskIdentifier, redact, buildRow, logEvent, logStep, classifyStep, scrubText, fallbackRing,
} from "../functions/_shared/system-log.js";
import { purgeOldSystemLogs, startLogRetention, stopLogRetention } from "../functions/_shared/log-retention.js";
import { pool } from "../functions/_shared/db.js";
import { _resetClientLogRateLimit } from "../functions/client-logs/index.js";

// Shared server for the whole file (pool.end() in stopServer closes the pool for every test).
before(async () => {
  await startServer();
  _resetClientLogRateLimit();
});
after(stopServer);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n = 6) => crypto.randomBytes(n).toString("hex");
const countOf = (text, needle) => (needle ? text.split(needle).length - 1 : 0);
const countRe = (text, re) => (text.match(re) || []).length;
const maskEmail = (e) => `${e[0]}***@${e.split("@")[1]}`;
const maskPhone = (p) => "******" + p.slice(-4);

// fetch-based request that also returns the X-Request-Id header.
async function req(method, path, { body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, rid: res.headers.get("x-request-id"), body: json };
}

async function waitFor(fn, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(50);
  }
  return null;
}

// Runs fn with pool.query replaced by a failing stub; console output is captured.
// `only` limits the failure to matching SQL, so only the logging write fails.
async function withBrokenDb(fn, { sync = false, only = () => true } = {}) {
  const origQuery = pool.query;
  const origLog = console.log;
  const origErr = console.error;
  const lines = [];
  console.log = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  pool.query = (text, ...rest) => {
    if (!only(String(text))) return origQuery.call(pool, text, ...rest);
    if (sync) throw new Error("simulated sync db outage");
    return Promise.reject(new Error("simulated db outage"));
  };
  try {
    return { result: await fn(), lines };
  } finally {
    pool.query = origQuery;
    console.log = origLog;
    console.error = origErr;
  }
}

describe("system log: masking and redaction (pure)", () => {
  it("masks emails as p***@domain and phones as ******1234", () => {
    assert.equal(maskIdentifier("priya.sharma@gmail.com"), "p***@gmail.com");
    assert.equal(maskIdentifier("+91 98765 43210"), "******3210");
    assert.equal(maskIdentifier(""), null);
  });

  it("masks plus-sign, uppercase and unicode local parts, trimming whitespace", () => {
    assert.equal(maskIdentifier("priya+tag@gmail.com"), "p***@gmail.com");
    const upper = maskIdentifier("Priya.Sharma@Gmail.COM");
    assert.equal(upper, "P***@Gmail.COM");
    assert.ok(!upper.includes("riya"));
    assert.equal(maskIdentifier("ñandu@example.test"), "ñ***@example.test");
    assert.equal(maskIdentifier("  a@b.co  "), "a***@b.co");
    assert.equal(maskIdentifier("@nolocal.com"), "***@nolocal.com");
  });

  it("handles null, undefined, numbers, phone formats and identifiers that are neither", () => {
    assert.equal(maskIdentifier(null), null);
    assert.equal(maskIdentifier(undefined), null);
    assert.equal(maskIdentifier(9876543210), "******3210");
    assert.equal(maskIdentifier("+919876543210"), "******3210");
    assert.equal(maskIdentifier("98765-43210"), "******3210");
    // Documented: a 4-digit identifier is shown in full (not a phone number, so not a leak).
    assert.equal(maskIdentifier("1234"), "******1234");
    assert.equal(maskIdentifier("abc"), "****");
    assert.equal(maskIdentifier("user_42"), "****");
  });

  it("never stores secret-looking keys, at any depth", () => {
    const out = redact({
      password: "hunter2",
      otp_code: "123456",
      nested: { access_token: "abc", Authorization: "Bearer x", keep: "ok", api_key: "k" },
      list: [{ secret: "s", value: 1 }],
    });
    const json = JSON.stringify(out);
    assert.ok(!json.includes("hunter2"));
    assert.ok(!json.includes("123456"));
    assert.ok(!json.includes("Bearer x"));
    assert.ok(!json.includes('"abc"'));
    assert.equal(out.nested.keep, "ok");
    assert.equal(out.list[0].value, 1);
  });

  it("scrubs emails inside free-text detail strings (stack traces, pg errors)", () => {
    const out = redact({ stack: "TypeError at priya.sharma@gmail.com line 3", detail: "Key (email)=(a.b@example.test) exists" });
    assert.equal(out.stack, "TypeError at p***@gmail.com line 3");
    assert.ok(!out.detail.includes("a.b@"));
  });

  it("masks identifiers inside details and scrubs emails from free text", () => {
    const row = buildRow({
      category: "otp.email",
      event: "otp.sent",
      outcome: "success",
      message: "sent to priya.sharma@gmail.com",
      identifier: "priya.sharma@gmail.com",
      details: { email: "priya.sharma@gmail.com", phone: "9876543210" },
    });
    assert.equal(row.masked_identifier, "p***@gmail.com");
    assert.ok(!row.message.includes("priya.sharma"));
    assert.equal(row.details.email, "p***@gmail.com");
    assert.equal(row.details.phone, "******3210");
    assert.equal(scrubText("call +919876543210 now"), "call ******3210 now");
  });

  it("scrubText masks emails and runs of 8 or more digits, but not short numbers in sentences", () => {
    assert.equal(scrubText("Mail priya@gmail.com now"), "Mail p***@gmail.com now");
    assert.equal(scrubText("Lesson 12 on day 3 of 45"), "Lesson 12 on day 3 of 45");
    // Spaced or hyphenated runs with fewer than 8 digits must stay readable.
    assert.equal(scrubText("Steps 1 2 3 4 5 6 7 done"), "Steps 1 2 3 4 5 6 7 done");
    // Documented false positive: an order ID with 8+ digits is masked like a phone number.
    assert.equal(scrubText("Order 1234567890 placed"), "Order ******7890 placed");
  });

  it("normalises unknown category and outcome and truncates long messages", () => {
    const row = buildRow({ category: "nope", event: "x", outcome: "weird", message: "a".repeat(1000) });
    assert.equal(row.category, "http");
    assert.equal(row.outcome, "info");
    assert.ok(row.message.length <= 300);
  });

  it("maps known backend steps to events and ignores unmapped steps", () => {
    assert.deepEqual(classifyStep("send-email-otp.sent"), { category: "otp.email", event: "otp.sent", outcome: "success" });
    assert.equal(classifyStep("auth-token.password.wrong_password").event, "login.failed");
    assert.equal(classifyStep("some-random.step"), null);
  });
});

describe("system log: storage and step forwarding", () => {
  it("logEvent stores a row with masked identifier and never throws", async () => {
    const marker = "marker-" + hex().replace(/[0-9]/g, "q");
    const ok = await logEvent({ category: "auth", event: "test.store", outcome: "info", message: marker, identifier: "a.b@example.test" });
    assert.equal(ok, true);
    const { rows } = await pool.query("SELECT masked_identifier FROM public.system_logs WHERE message = $1", [marker]);
    assert.equal(rows[0].masked_identifier, "a***@example.test");
  });

  it("a WhatsApp OTP step is stored with category otp.whatsapp, not otp.sms", async () => {
    const purpose = "wa-" + hex();
    logStep("info", "send-phone-otp.sent", { phone: "9123456789", channel: "whatsapp", purpose });
    const rows = await waitFor(async () => {
      const r = await pool.query("SELECT category FROM public.system_logs WHERE details->>'purpose' = $1", [purpose]);
      return r.rows.length ? r.rows : null;
    });
    assert.ok(rows, "row written");
    assert.equal(rows[0].category, "otp.whatsapp");
  });

  it("retention deletes rows older than 14 days and keeps rows at 13 days 23 hours", async () => {
    const oldMarker = "old-" + hex();
    const edgeMarker = "edge-" + hex();
    const pastMarker = "past-" + hex();
    await pool.query("INSERT INTO public.system_logs (category,event,outcome,message,ts) VALUES ('auth','t','info',$1, now() - interval '15 days')", [oldMarker]);
    await pool.query("INSERT INTO public.system_logs (category,event,outcome,message,ts) VALUES ('auth','t','info',$1, now() - interval '14 days 1 minute')", [pastMarker]);
    await pool.query("INSERT INTO public.system_logs (category,event,outcome,message,ts) VALUES ('auth','t','info',$1, now() - interval '13 days 23 hours')", [edgeMarker]);
    const deleted = await purgeOldSystemLogs();
    assert.equal(typeof deleted, "number");
    assert.ok(deleted >= 2, `purge reports deleted rows (got ${deleted})`);
    const { rows } = await pool.query("SELECT message FROM public.system_logs WHERE message IN ($1,$2,$3)", [oldMarker, pastMarker, edgeMarker]);
    const msgs = rows.map((r) => r.message);
    assert.ok(!msgs.includes(oldMarker), "15-day-old row must be deleted");
    assert.ok(!msgs.includes(pastMarker), "14 days 1 minute old row must be deleted");
    assert.ok(msgs.includes(edgeMarker), "13 days 23 hours old row must be kept");
  });

  it("startLogRetention and stopLogRetention start and clear the timer, and the timer is unref'd", async () => {
    const t1 = startLogRetention();
    assert.equal(t1.hasRef(), false, "retention timer must not keep the process alive");
    const t2 = startLogRetention();
    assert.equal(t1._destroyed, true, "starting again must clear the previous timer");
    assert.equal(t2.hasRef(), false);
    stopLogRetention();
    assert.equal(t2._destroyed, true, "stop clears the timer");
    stopLogRetention(); // idempotent
  });

  it("a failed login writes a login.failed row with the request id, and never the password", async () => {
    const email = uniqueEmail("fail");
    const password = "Wrong-" + hex(8) + "!x";
    const su = await req("POST", "/auth/v1/signup", { body: { email, password: "Right-" + hex(8) + "!y", data: { full_name: "F", phone: uniquePhone() } } });
    assert.equal(su.status, 200);
    const r = await req("POST", "/auth/v1/token?grant_type=password", { body: { email, password } });
    assert.equal(r.status, 400);
    const rows = await waitFor(async () => {
      const x = await pool.query(
        `SELECT outcome, masked_identifier, details::text AS d, message, request_id FROM public.system_logs
          WHERE category = 'auth' AND event = 'login.failed' AND request_id = $1`,
        [r.rid]
      );
      return x.rows.length ? x.rows : null;
    });
    assert.ok(rows, "login.failed row exists");
    assert.equal(rows[0].outcome, "failed");
    assert.equal(rows[0].masked_identifier, maskEmail(email));
    assert.ok(!rows[0].d.includes(password));
    assert.ok(!rows[0].message.includes(email));
  });

  it("every http response carries X-Request-Id and writes one request row", async () => {
    const res = await fetch(base + "/health");
    await res.text();
    const id = res.headers.get("x-request-id");
    assert.match(id, /^[0-9a-f]{12}$/);
    const n = await waitFor(async () => {
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM public.system_logs WHERE category='http' AND request_id = $1", [id]);
      return rows[0].n === 1 ? rows[0].n : null;
    });
    assert.equal(n, 1);
  });

  it("frontend log endpoint stores a frontend row and rejects empty messages", async () => {
    const marker = "frontend-" + hex();
    const bad = await req("POST", "/api/client-logs", { body: { event: "x" } });
    assert.equal(bad.status, 400);
    const ok = await req("POST", "/api/client-logs", { body: { event: "boom", message: marker, page: "/x", stack: "s" } });
    assert.equal(ok.status, 202);
    const rows = await waitFor(async () => {
      const { rows } = await pool.query("SELECT category FROM public.system_logs WHERE message = $1", [marker]);
      return rows.length ? rows : null;
    });
    assert.equal(rows[0].category, "frontend");
  });

  it("system_logs has RLS enabled and no grants to anon or authenticated", async () => {
    const rows = await q(
      "SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='system_logs'"
    );
    assert.equal(rows[0].relrowsecurity, true);
    const grants = await q(
      `SELECT grantee FROM information_schema.role_table_grants
        WHERE table_schema='public' AND table_name='system_logs' AND grantee IN ('anon','authenticated')`
    );
    assert.equal(grants.length, 0);
  });
});

describe("system log: leak sweep over real HTTP flows", () => {
  const S = { rid: {}, status: {}, issued: [] };

  before(async () => {
    S.password = "LeakCheck-" + hex(5) + "!Z";
    S.email = uniqueEmail("leak");
    S.phone = uniquePhone();
    S.start = (await q("SELECT now()::text AS t"))[0].t;

    const su = await req("POST", "/auth/v1/signup", {
      body: { email: S.email, password: S.password, data: { full_name: "Leak Check", phone: S.phone } },
    });
    S.rid.signup = su.rid; S.status.signup = su.status;
    S.access = su.body?.access_token; S.refresh = su.body?.refresh_token;
    S.issued.push(S.access, S.refresh);

    const ok = await req("POST", "/auth/v1/token?grant_type=password", { body: { email: S.email, password: S.password } });
    S.rid.loginOk = ok.rid; S.status.loginOk = ok.status;
    S.issued.push(ok.body?.access_token, ok.body?.refresh_token);

    const bad = await req("POST", "/auth/v1/token?grant_type=password", { body: { email: S.email, password: S.password + "-wrong" } });
    S.rid.loginBad = bad.rid; S.status.loginBad = bad.status;

    const sendE = await req("POST", "/functions/v1/send-email-otp", { body: { email: S.email, purpose: "login" } });
    S.rid.sendEmail = sendE.rid; S.status.sendEmail = sendE.status;
    S.emailCode = emailCode(S.email);

    const wrong = S.emailCode === "000000" ? "111111" : "000000";
    const vw = await req("POST", "/functions/v1/verify-email-otp", { body: { email: S.email, otp_code: wrong, purpose: "login" } });
    S.rid.verifyWrong = vw.rid; S.status.verifyWrong = vw.status;

    const vo = await req("POST", "/functions/v1/verify-email-otp", { body: { email: S.email, otp_code: S.emailCode, purpose: "login" } });
    S.rid.verifyOk = vo.rid; S.status.verifyOk = vo.status;
    S.issued.push(vo.body?.access_token, vo.body?.refresh_token);

    const sms = await req("POST", "/functions/v1/send-phone-otp", { body: { phone: S.phone, purpose: "login", channel: "sms" } });
    S.rid.sendSms = sms.rid; S.status.sendSms = sms.status;
    S.smsCode = phoneCode(S.phone);

    const wa = await req("POST", "/functions/v1/send-phone-otp", { body: { phone: S.phone, purpose: "login", channel: "whatsapp" } });
    S.rid.sendWa = wa.rid; S.status.sendWa = wa.status;
    S.waCode = phoneCode(S.phone);

    const rf = await req("POST", "/auth/v1/token?grant_type=refresh_token", { body: { refresh_token: S.refresh } });
    S.rid.refresh = rf.rid; S.status.refresh = rf.status;
    S.issued.push(rf.body?.access_token, rf.body?.refresh_token);

    const lo = await req("POST", "/auth/v1/logout", { headers: { Authorization: `Bearer ${rf.body?.access_token ?? S.access}` } });
    S.rid.logout = lo.rid; S.status.logout = lo.status;

    const cl = await req("POST", "/api/client-logs", {
      body: {
        event: "ui-error",
        message: `Save failed for ${S.email} on ${S.phone}`,
        page: "/profile",
        stack: `TypeError: contact ${S.email} ${S.phone}\n    at save (app.js:1:1)`,
        source: "window.onerror",
        app_version: "1.0.0",
      },
    });
    S.rid.client = cl.rid; S.status.client = cl.status;

    S.issued = S.issued.filter((t) => typeof t === "string" && t.length > 20);
    await sleep(600);
  });

  it("every flow returns its expected status and the OTP codes were captured from dry-run", () => {
    assert.deepEqual(S.status, {
      signup: 200, loginOk: 200, loginBad: 400, sendEmail: 200, verifyWrong: 401, verifyOk: 200,
      sendSms: 200, sendWa: 200, refresh: 200, logout: 204, client: 202,
    });
    assert.match(S.emailCode || "", /^\d{6}$/);
    assert.match(S.smsCode || "", /^\d{6}$/);
    assert.match(S.waCode || "", /^\d{6}$/);
    assert.ok(S.issued.length >= 2, "tokens captured");
  });

  it("leak sweep: no email, phone, OTP, password, JWT or token in any system_logs row written during the run", async () => {
    const rows = await q(
      `SELECT category, event, outcome, message, masked_identifier, details::text AS details
         FROM public.system_logs WHERE ts >= $1::timestamptz`,
      [S.start]
    );
    assert.ok(rows.length > 0, "rows were written");
    // request_id and ts are excluded on purpose: random hex and timestamps can contain digit runs.
    const blob = rows.map((r) => JSON.stringify(r)).join("\n");
    const otpRe = (code) => new RegExp(`(?<!\\d)${code}(?!\\d)`, "g");
    const hits = {
      full_email: countOf(blob, S.email),
      phone: countRe(blob, new RegExp(`(?<!\\d)(?:\\+?91[\\s-]?)?${S.phone.slice(0, 5)}[\\s-]?${S.phone.slice(5)}(?!\\d)`, "g")),
      otp_email: countRe(blob, otpRe(S.emailCode)),
      otp_sms: countRe(blob, otpRe(S.smsCode)),
      otp_whatsapp: countRe(blob, otpRe(S.waCode)),
      password: countOf(blob, S.password),
      jwt: countRe(blob, /[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g),
      token_value: S.issued.reduce((n, t) => n + countOf(blob, t), 0),
    };
    assert.deepEqual(hits, {
      full_email: 0, phone: 0, otp_email: 0, otp_sms: 0, otp_whatsapp: 0, password: 0, jwt: 0, token_value: 0,
    });

  });

  it("mapping: each flow produces the expected system_logs event with category, outcome and masked identifier", async () => {
    const rows = await q(
      `SELECT category, event, outcome, status_code, masked_identifier, request_id FROM public.system_logs
        WHERE ts >= $1::timestamptz ORDER BY id`,
      [S.start]
    );
    const M = maskEmail(S.email);
    const P = maskPhone(S.phone);
    const expected = [
      { flow: "signup", category: "auth", event: "signup.requested", outcome: "info", masked: M, rid: S.rid.signup },
      { flow: "login ok", category: "auth", event: "login.success", outcome: "success", masked: M, rid: S.rid.loginOk },
      { flow: "login bad", category: "auth", event: "login.failed", outcome: "failed", masked: M, rid: S.rid.loginBad },
      { flow: "email otp request", category: "otp.email", event: "otp.requested", outcome: "info", masked: M, rid: S.rid.sendEmail },
      { flow: "email otp sent", category: "otp.email", event: "otp.sent", outcome: "success", masked: M, rid: S.rid.sendEmail },
      { flow: "email verify wrong", category: "otp.email", event: "otp.wrong_code", outcome: "failed", masked: M, rid: S.rid.verifyWrong },
      { flow: "email verify ok", category: "otp.email", event: "otp.verified", outcome: "success", masked: M, rid: S.rid.verifyOk },
      { flow: "email session", category: "otp.email", event: "otp.session_issued", outcome: "success", masked: M, rid: S.rid.verifyOk },
      { flow: "sms sent", category: "otp.sms", event: "otp.sent", outcome: "success", masked: P, rid: S.rid.sendSms },
      { flow: "whatsapp sent", category: "otp.whatsapp", event: "otp.sent", outcome: "success", masked: P, rid: S.rid.sendWa },
      { flow: "refresh", category: "auth", event: "refresh.success", outcome: "success", masked: M, rid: S.rid.refresh },
      { flow: "logout", category: "auth", event: "logout", outcome: "info", masked: null, rid: S.rid.logout },
      { flow: "frontend error", category: "frontend", event: "ui-error", outcome: "failed", masked: null, rid: S.rid.client },
    ];
    const gaps = [];
    for (const e of expected) {
      const hit = rows.find(
        (r) => r.category === e.category && r.event === e.event && r.request_id === e.rid &&
          r.outcome === e.outcome && r.masked_identifier === e.masked
      );
      if (!hit) gaps.push(`${e.flow}: ${e.category}/${e.event} (${e.outcome}, ${e.masked ?? "no identifier"})`);
    }
    assert.deepEqual(gaps, [], "missing or wrong system_logs events");
  });

  it("every flow writes exactly one http row whose request_id is the X-Request-Id header and whose message has no query string", async () => {
    const expectStatus = {
      signup: S.status.signup, loginOk: S.status.loginOk, loginBad: S.status.loginBad, sendEmail: S.status.sendEmail,
      verifyWrong: S.status.verifyWrong, verifyOk: S.status.verifyOk, sendSms: S.status.sendSms, sendWa: S.status.sendWa,
      refresh: S.status.refresh, logout: S.status.logout, client: S.status.client,
    };
    for (const [name, rid] of Object.entries(S.rid)) {
      const rows = await q(
        "SELECT status_code, message FROM public.system_logs WHERE category = 'http' AND request_id = $1",
        [rid]
      );
      assert.equal(rows.length, 1, `${name}: exactly one http row`);
      assert.equal(rows[0].status_code, expectStatus[name], `${name}: http status_code`);
      assert.ok(!/\?|grant_type|refresh_token/.test(rows[0].message), `${name}: no query string in message`);
    }
  });
});

describe("system log: failure isolation", () => {
  it("logEvent resolves false, keeps the entry in fallbackRing and prints to stdout when the DB write fails", async () => {
    fallbackRing.length = 0;
    const { result, lines } = await withBrokenDb(() =>
      logEvent({ category: "auth", event: "iso.fail", outcome: "failed", message: "iso-marker", identifier: "x@example.test" })
    );
    assert.equal(result, false);
    assert.equal(fallbackRing.length, 1);
    assert.equal(fallbackRing[0].event, "iso.fail");
    assert.equal(fallbackRing[0].masked_identifier, "x***@example.test");
    assert.ok(fallbackRing[0].db_error.includes("simulated db outage"));
    assert.ok(lines.some((l) => l.includes("system-log.db_write_failed")), "message printed to stdout");
  });

  it("a synchronous throw from the DB layer is handled the same way (no throw, ring, stdout)", async () => {
    fallbackRing.length = 0;
    const { result, lines } = await withBrokenDb(() => logEvent({ category: "auth", event: "iso.sync", outcome: "failed" }), { sync: true, only: (sql) => sql.includes("INSERT INTO public.system_logs") });
    assert.equal(result, false);
    assert.equal(fallbackRing.length, 1);
    assert.ok(lines.some((l) => l.includes("system-log.db_write_failed")));
  });

  it("the fallback ring is capped at 500 entries and keeps the newest", async () => {
    fallbackRing.length = 0;
    await withBrokenDb(async () => {
      for (let i = 0; i < 510; i++) await logEvent({ category: "http", event: "cap." + i, outcome: "info" });
    });
    assert.equal(fallbackRing.length, 500);
    assert.equal(fallbackRing[0].event, "cap.10");
    assert.equal(fallbackRing.at(-1).event, "cap.509");
    fallbackRing.length = 0;
  });

  it("requests still return their normal status when logging fails", async () => {
    const { result } = await withBrokenDb(async () => {
      const health = await fetch(base + "/health");
      await health.text();
      const client = await req("POST", "/api/client-logs", { body: { event: "e", message: "while db down" } });
      return { health: health.status, rid: health.headers.get("x-request-id"), client: client.status };
    }, { only: (sql) => sql.includes("INSERT INTO public.system_logs") });
    assert.equal(result.health, 200);
    assert.match(result.rid, /^[0-9a-f]{12}$/);
    assert.equal(result.client, 202);
  });
});

describe("system log: concurrency and request ids", () => {
  it("300 concurrent logEvent calls: every row stored exactly once, no lost entries, no unhandled rejections", async () => {
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const run = "conc" + hex(6);
      const results = await Promise.all(
        Array.from({ length: 300 }, (_, i) => logEvent({ category: "http", event: "conc.test", outcome: "info", message: `${run}-${i}`, requestId: hex(6) }))
      );
      assert.equal(results.filter(Boolean).length, 300, "every write resolved true");
      await sleep(300);
      const { rows } = await pool.query("SELECT message FROM public.system_logs WHERE message LIKE $1", [run + "-%"]);
      assert.equal(rows.length, 300, "300 rows stored");
      assert.equal(new Set(rows.map((r) => r.message)).size, 300, "no duplicates");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    assert.equal(unhandled.length, 0, "no unhandled rejections");
  });

  it("concurrent requests each get a distinct 12-hex X-Request-Id", async () => {
    const ids = await Promise.all(
      Array.from({ length: 50 }, async () => {
        const r = await fetch(base + "/health");
        await r.text();
        return r.headers.get("x-request-id");
      })
    );
    for (const id of ids) assert.match(id, /^[0-9a-f]{12}$/);
    assert.equal(new Set(ids).size, 50, "all ids distinct");
  });

  it("two concurrent failed logins with different emails keep their own request_id on their login.failed rows", async () => {
    const a = uniqueEmail("cona");
    const b = uniqueEmail("conb");
    for (const e of [a, b]) {
      const su = await req("POST", "/auth/v1/signup", { body: { email: e, password: "Pw-" + hex(6) + "!q", data: { full_name: "C", phone: uniquePhone() } } });
      assert.equal(su.status, 200);
    }
    const [ra, rb] = await Promise.all([
      req("POST", "/auth/v1/token?grant_type=password", { body: { email: a, password: "bad-a-" + hex(4) } }),
      req("POST", "/auth/v1/token?grant_type=password", { body: { email: b, password: "bad-b-" + hex(4) } }),
    ]);
    assert.equal(ra.status, 400);
    assert.equal(rb.status, 400);
    const rowFor = (rid) =>
      waitFor(async () => {
        const { rows } = await pool.query(
          "SELECT masked_identifier, request_id FROM public.system_logs WHERE category='auth' AND event='login.failed' AND request_id = $1",
          [rid]
        );
        return rows.length ? rows : null;
      });
    const [rowA, rowB] = await Promise.all([rowFor(ra.rid), rowFor(rb.rid)]);
    assert.equal(rowA.length, 1);
    assert.equal(rowB.length, 1);
    assert.equal(rowA[0].masked_identifier, maskEmail(a));
    assert.equal(rowB[0].masked_identifier, maskEmail(b));
  });
});
