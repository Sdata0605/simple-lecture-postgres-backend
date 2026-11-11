import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { startServer, stopServer, call, q, base } from "./helpers.js";
import { logEvent } from "../functions/_shared/system-log.js";
import { configuredProviders, _resetProviderStatusCache } from "../functions/_shared/provider-status.js";
import { _testHooks } from "../functions/admin-logs/index.js";
import { pool } from "../functions/_shared/db.js";

// The key is random per run and is never printed. Set at module level, after the imports, so it
// overrides any value that dotenv loaded from .env.
const ADMIN_KEY = crypto.randomBytes(24).toString("base64url");
process.env.ADMIN_LOG_KEY = ADMIN_KEY;

const RUN = crypto.randomBytes(4).toString("hex");
const M = `ADMINT-${RUN}`; // marker for rows inserted by this file
const PAGE = `PAGE-${RUN}`;
const SEC = `SECRET-${RUN}`;
const FX = `FORMULA-${RUN}`;
const CAP = `CAP-${RUN}`;
const DEL = `DELROW-${RUN}`;
const UNI = `UNI-${RUN}`;

let adminToken;

async function login(key, headers = {}) {
  const res = await fetch(`${base}/admin/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ key }),
  });
  const text = await res.text();
  return { status: res.status, setCookie: res.headers.get("set-cookie") || "", body: text ? JSON.parse(text) : null, text };
}
const tokenFrom = (setCookie) => /sl_admin=([^;]+)/.exec(setCookie)?.[1];
const authed = (token) => ({ headers: { Cookie: `sl_admin=${token}` } });
const getAuthed = (path, token = adminToken) => call("GET", path, authed(token));

async function list(qs, token = adminToken) {
  const r = await getAuthed(`/admin/api/logs?${qs}`, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
const requestIds = (items) => items.map((i) => i.request_id).sort();

// Every item of a filter, following next_cursor.
async function listAll(qs, limit = 3) {
  const items = [];
  let cursor = "";
  for (let i = 0; i < 1000; i++) {
    const body = await list(`${qs}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    items.push(...body.items);
    cursor = body.next_cursor;
    if (!cursor) return items;
  }
  throw new Error("pagination did not end");
}

// Responses must never show SQL text, driver errors or stack frames.
function assertNoLeak(status, body) {
  const s = typeof body === "string" ? body : JSON.stringify(body);
  assert.notEqual(status, 500, `500 response: ${s.slice(0, 200)}`);
  assert.doesNotMatch(s, /SELECT|INSERT|syntax|system_logs|relation|\bpg\b|\n\s+at |<pre>/i);
}

const ms = (n) => n * 60 * 1000;

describe("admin log API", () => {
  before(async () => {
    await startServer();
  });
  after(async () => {
    await q("DELETE FROM public.system_logs WHERE request_id LIKE $1 OR message LIKE $1", [`%${RUN}%`]);
    await stopServer();
  });

  // ---- 1. auth

  it("every read endpoint returns 401 without a valid session cookie", async () => {
    const paths = [
      "/admin/api/logs",
      "/admin/api/logs/1",
      "/admin/api/logs/export?format=csv",
      "/admin/api/logs/summary",
      "/admin/api/providers/status",
    ];
    for (const p of paths) {
      const none = await call("GET", p);
      assert.equal(none.status, 401, p);
      assert.deepEqual(none.body, { error: "unauthorized" }, p);
      const fake = await call("GET", p, { headers: { Cookie: "sl_admin=not-a-real-token" } });
      assert.equal(fake.status, 401, p);
    }
  });

  it("malformed or odd cookie headers get 401, never 500", async () => {
    const cookies = [
      "sl_admin=",
      "sl_admin",
      "sl_admin=a;sl_admin=b",
      "Sl_Admin=abc",
      "sl_admin=" + "x".repeat(8000),
      "sl_admin=__proto__",
      "sl_admin=constructor",
      "=;;;",
    ];
    for (const c of cookies) {
      const r = await call("GET", "/admin/api/logs", { headers: { Cookie: c } });
      assert.equal(r.status, 401, c.slice(0, 30));
    }
  });

  it("a wrong key gets 401 and reveals nothing about the key", async () => {
    const r = await login("not-the-key");
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: "invalid_key" });
    assert.equal(r.setCookie, "");
  });

  it("login bodies that are empty, mistyped or oversized never 500 and never echo a stack", async () => {
    const raw = async (promise) => {
      const r = await promise;
      return { status: r.status, text: await r.text() };
    };
    const variants = [
      { name: "no body", send: () => raw(fetch(`${base}/admin/api/login`, { method: "POST" })) },
      { name: "empty object", send: () => login(undefined) },
      { name: "key as number", send: () => login(12345678) },
      { name: "key as array", send: () => login([ADMIN_KEY]) },
      { name: "key as object", send: () => login({ value: ADMIN_KEY }) },
      { name: "key missing", send: () => raw(fetch(`${base}/admin/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })) },
      { name: "key with unicode", send: () => login("ी\u{1F510}-wrong") },
      { name: "key with NUL byte", send: () => login("abc\u0000def") },
      { name: "very long key (under the 1 MB limit)", send: () => login("k".repeat(500_000)) },
    ];
    for (const v of variants) {
      _testHooks.failures.clear(); // each variant is a failed login; keep them from tripping the limit
      const { status, text } = await v.send();
      assert.ok([400, 401].includes(status), `${v.name}: got ${status}`);
      assertNoLeak(status, text);
    }
    _testHooks.failures.clear();
  });

  it("non-JSON body is rejected with a JSON 400 and no stack trace", { todo: "BUG (src/app.js line 205): express.json error falls to Express's default HTML handler, which prints the parser stack in non-production" }, async () => {
    const res = await fetch(`${base}/admin/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad json" });
    const text = await res.text();
    assert.equal(res.status, 400);
    assert.match(res.headers.get("content-type") || "", /json/);
    assertNoLeak(res.status, text);
  });

  it("oversized body is rejected with 413 and no stack trace", { todo: "BUG (src/app.js line 205): same default error handler; 413 HTML page includes the body-parser stack" }, async () => {
    const res = await fetch(`${base}/admin/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "a".repeat(1_200_000) }) });
    const text = await res.text();
    assert.equal(res.status, 413);
    assertNoLeak(res.status, text);
  });

  it("the right key sets an HttpOnly, SameSite=Strict session cookie for /admin", async () => {
    const r = await login(ADMIN_KEY);
    assert.equal(r.status, 200);
    assert.match(r.setCookie, /HttpOnly/);
    assert.match(r.setCookie, /SameSite=Strict/);
    assert.match(r.setCookie, /Path=\/admin/);
    assert.match(r.setCookie, /Max-Age=28800/, "8 hour session");
    if (process.env.NODE_ENV !== "production") assert.doesNotMatch(r.setCookie, /Secure/);
    adminToken = tokenFrom(r.setCookie);
    assert.ok(adminToken && adminToken.length >= 32);
    assert.equal((await getAuthed("/admin/api/logs")).status, 200);
  });

  it("Secure is added to the cookie only when NODE_ENV=production", async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const r = await login(ADMIN_KEY);
      assert.equal(r.status, 200);
      assert.match(r.setCookie, /;\s*Secure/);
      assert.match(r.setCookie, /HttpOnly/);
      assert.match(r.setCookie, /SameSite=Strict/);
      const out = await fetch(`${base}/admin/api/logout`, { method: "POST", headers: { Cookie: `sl_admin=${tokenFrom(r.setCookie)}` } });
      assert.match(out.headers.get("set-cookie") || "", /;\s*Secure/);
    } finally {
      if (saved === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = saved;
    }
  });

  it("an expired session is refused and removed", async () => {
    const r = await login(ADMIN_KEY);
    const token = tokenFrom(r.setCookie);
    assert.equal((await getAuthed("/admin/api/logs", token)).status, 200);
    _testHooks.sessions.set(token, Date.now() - 1); // age it past its 8 hour expiry
    assert.equal((await getAuthed("/admin/api/logs", token)).status, 401);
    assert.equal(_testHooks.sessions.has(token), false, "expired token is deleted on use");
  });

  it("fails closed with 503 when ADMIN_LOG_KEY is unset", async () => {
    const saved = process.env.ADMIN_LOG_KEY;
    delete process.env.ADMIN_LOG_KEY;
    try {
      const r = await login(ADMIN_KEY);
      assert.equal(r.status, 503);
    } finally {
      process.env.ADMIN_LOG_KEY = saved;
    }
  });

  it("login events are logged without the key", async () => {
    const rows = await q(
      `SELECT count(*)::int AS n FROM public.system_logs
        WHERE category = 'auth' AND (strpos(message, $1) > 0 OR strpos(coalesce(details::text, ''), $1) > 0)`,
      [ADMIN_KEY]
    );
    assert.equal(rows[0].n, 0, "the key must never be stored");
    const events = await q("SELECT DISTINCT event FROM public.system_logs WHERE category = 'auth' AND event LIKE 'login.%'");
    const names = events.map((e) => e.event);
    assert.ok(names.includes("login.success"));
    assert.ok(names.includes("login.failed"));
  });

  it("logout invalidates the session and clears the cookie", async () => {
    const r = await login(ADMIN_KEY);
    const token = tokenFrom(r.setCookie);
    const res = await fetch(`${base}/admin/api/logout`, { method: "POST", headers: { Cookie: `sl_admin=${token}` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("set-cookie") || "", /Max-Age=0/);
    assert.equal((await getAuthed("/admin/api/logs", token)).status, 401);
    assert.equal((await getAuthed("/admin/api/logs")).status, 200, "other sessions are unaffected");
  });

  // ---- filters

  const rows = {};
  let t0;
  it("filters return only matching rows", async () => {
    t0 = new Date(Date.now() - 1000);
    await logEvent({ category: "auth", event: "t.a", outcome: "success", statusCode: 200, message: `${M} alpha`, requestId: `${RUN}-a` });
    await logEvent({ category: "otp.sms", event: "t.b", outcome: "failed", statusCode: 500, message: `${M} bravo`, requestId: `${RUN}-b`, identifier: "9876543210" });
    await logEvent({ category: "provider", event: "t.c", outcome: "info", statusCode: 404, message: `${M} charlie`, requestId: `${RUN}-c` });
    await logEvent({ category: "http", event: "t.d", outcome: "success", statusCode: 201, message: `${M} delta`, requestId: `${RUN}-d` });
    await logEvent({ category: "http", event: "t.e", outcome: "success", statusCode: 200, message: `${M} 100%_done`, requestId: `${RUN}-e` });

    const all = await list(`q=${M}&limit=100`);
    assert.deepEqual(requestIds(all.items), ["e", "d", "c", "b", "a"].map((s) => `${RUN}-${s}`).sort());
    for (const item of all.items) rows[item.request_id] = item;

    const ids = async (qs) => requestIds((await list(`q=${M}&${qs}`)).items);
    assert.deepEqual(await ids("category=otp.sms"), [`${RUN}-b`]);
    assert.deepEqual(await ids("outcome=failed"), [`${RUN}-b`]);
    assert.deepEqual(await ids("errors_only=true"), [`${RUN}-b`, `${RUN}-c`].sort());
    assert.equal((await list(`q=${M}&errors_only=false`)).items.length, 5);
    assert.deepEqual(await ids("status_class=5xx"), [`${RUN}-b`]);
    assert.deepEqual(await ids("status_class=4xx"), [`${RUN}-c`]);
    assert.deepEqual(await ids("status_class=2xx"), [`${RUN}-a`, `${RUN}-d`, `${RUN}-e`].sort());
    assert.deepEqual(await ids("category=frontend"), []);
  });

  it("the time window (from/to, UTC) includes and excludes rows correctly", async () => {
    const before = new Date(t0.getTime() - 60_000).toISOString();
    const after = new Date(Date.now() + 60_000).toISOString();
    assert.equal((await list(`q=${M}&from=${before}&to=${after}`)).items.length, 5);
    assert.equal((await list(`q=${M}&from=${after}`)).items.length, 0, "from in the future");
    assert.equal((await list(`q=${M}&from=${before}&to=${t0.toISOString()}`)).items.length, 0, "to before the rows");
  });

  it("valid time formats are accepted (date only, offsets, leap day, fractions)", async () => {
    for (const qs of [
      "from=2024-02-29",
      "from=2026-02-28T23:59:59.999Z",
      "from=2026-11-05T10:00Z",
      "from=2026-11-05T15:30:00%2B05:30",
      "from=2026-11-05T15:30:00%2B0530",
      "from=0001-01-01",
      "to=9999-12-31T23:59:59Z",
    ]) {
      assert.equal((await getAuthed(`/admin/api/logs?${qs}&limit=1`)).status, 200, qs);
    }
  });

  it("q is matched with escaped wildcards, so a literal % or _ matches only literally", async () => {
    const items = (await list(`q=${encodeURIComponent(`${M} 100%_`)}`)).items;
    assert.deepEqual(requestIds(items), [`${RUN}-e`]);
    // An unescaped % would match every ADMINT row here. A literal % after the marker matches none.
    assert.equal((await list(`q=${encodeURIComponent(`${M}%`)}`)).items.length, 0);
    assert.equal((await list(`q=${encodeURIComponent(`${M}_`)}`)).items.length, 0);
  });

  it("unicode q matches unicode text", async () => {
    await logEvent({ category: "http", event: "t.uni", outcome: "info", statusCode: 200, message: `${UNI} café \u{1F642} ünïcode`, requestId: `${RUN}-uni` });
    assert.deepEqual(requestIds((await list(`q=${encodeURIComponent(`${UNI} café`)}`)).items), [`${RUN}-uni`]);
    assert.deepEqual(requestIds((await list(`q=${encodeURIComponent("ünïcode")}&limit=500`)).items).filter((r) => r.includes(RUN)), [`${RUN}-uni`]);
  });

  it("q at the 100 character limit is accepted, 101 is rejected", async () => {
    assert.equal((await getAuthed(`/admin/api/logs?q=${"a".repeat(100)}`)).status, 200);
    assert.equal((await getAuthed(`/admin/api/logs?q=${"a".repeat(101)}`)).status, 400);
  });

  it("q containing a NUL byte is rejected with 400, not 500", async () => {
    const r = await getAuthed(`/admin/api/logs?q=%00abc`);
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: "q_invalid" });
    assert.equal((await getAuthed(`/admin/api/logs/export?format=json&q=%00`)).status, 400);
  });

  it("rejects bad input with 400", async () => {
    const bad = [
      "from=yesterday",
      "from=2026-13-40T00:00:00Z",
      "from=2026-02-30",
      "from=0000-01-01",
      "from=2026/11/05",
      "from=05-11-2026",
      "from=2026-11-05T25:00:00Z",
      "from=2026-11-05T10:00:00%2B99:99",
      "from=2026-11-05T10:00:00Z.5",
      "from=2026-11-05T10:00:00.1234567890Z",
      "to=not-a-date",
      "from=2026-11-05T10:00:00Z&to=2026-11-04T10:00:00Z",
      "category=nope",
      "category=%27%20OR%20%271%27%3D%271",
      "outcome=maybe",
      "status_class=3xx",
      "errors_only=yes",
      "limit=0",
      "limit=-1",
      "limit=1e9",
      "limit=NaN",
      "limit=1.5",
      "limit=abc",
      "cursor=%25%25%25bad",
      "cursor=YWJj",
      `cursor=${Buffer.from("2026-02-30 00:00:00+00|1").toString("base64")}`,
      `cursor=${Buffer.from("0000-01-01 00:00:00+00|1").toString("base64")}`,
      `cursor=${Buffer.from("2026-11-05 10:00:00+00|abc").toString("base64")}`,
      `cursor=${Buffer.from("2026-11-05 10:00:00+99|1").toString("base64")}`,
      "from=2026-11-05T10:00:00Z&from=2026-11-05T11:00:00Z",
    ];
    for (const qs of bad) {
      const r = await getAuthed(`/admin/api/logs?${qs}`);
      assert.equal(r.status, 400, qs);
      assertNoLeak(r.status, r.body);
    }
  });

  it("SQL metacharacters in every query parameter are harmless (no 500, no SQL text, table intact)", async () => {
    const payloads = ["' OR 1=1 --", "\"; DROP TABLE public.system_logs; --", "\\", "%", "_", "$1", "'||pg_sleep(0)||'", "1;SELECT 1"];
    const params = ["q", "category", "outcome", "status_class", "errors_only", "from", "to", "limit", "cursor"];
    for (const p of payloads) {
      for (const name of params) {
        const r = await getAuthed(`/admin/api/logs?${name}=${encodeURIComponent(p)}`);
        assertNoLeak(r.status, r.body);
        assert.ok([200, 400].includes(r.status), `${name}=${p}: ${r.status}`);
      }
      const one = await getAuthed(`/admin/api/logs/${encodeURIComponent(p)}`);
      assertNoLeak(one.status, one.body);
      const ex = await getAuthed(`/admin/api/logs/export?format=${encodeURIComponent(p)}&q=${encodeURIComponent(p)}`);
      assertNoLeak(ex.status, ex.body);
      const sm = await getAuthed(`/admin/api/logs/summary?bucket=${encodeURIComponent(p)}`);
      assertNoLeak(sm.status, sm.body);
    }
    const alive = await q("SELECT count(*)::int AS n FROM public.system_logs");
    assert.ok(alive[0].n > 0, "table still exists and has rows");
  });

  it("GET /logs/:id returns one row with details, and 404 when missing", async () => {
    const item = rows[`${RUN}-b`];
    assert.ok(item, "row b must be in the list");
    const r = await getAuthed(`/admin/api/logs/${item.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.id, item.id);
    assert.equal(r.body.status_code, 500);
    assert.equal(r.body.masked_identifier, "******3210");
    assert.ok("details" in r.body);
    assert.equal((await getAuthed("/admin/api/logs/abc")).status, 400);
    assert.equal((await getAuthed("/admin/api/logs/0")).status, 404);
    assert.equal((await getAuthed("/admin/api/logs/999999999999")).status, 404);
    assert.equal((await getAuthed("/admin/api/logs/99999999999999999999")).status, 400);
  });

  it("cursor pagination returns every row once, with no duplicates", async () => {
    for (let i = 0; i < 7; i++) {
      await logEvent({ category: "frontend", event: "t.page", outcome: "failed", statusCode: 400, message: `${PAGE} ${i}`, requestId: `${RUN}-p${i}` });
    }
    const seen = [];
    let cursor = "";
    let pages = 0;
    do {
      const body = await list(`q=${PAGE}&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      assert.ok(body.items.length <= 3);
      seen.push(...body.items.map((i) => i.request_id));
      cursor = body.next_cursor;
      pages++;
    } while (cursor && pages < 10);
    assert.equal(pages, 3);
    assert.equal(seen.length, 7);
    assert.equal(new Set(seen).size, 7, "no duplicates across pages");
    assert.deepEqual([...seen].sort(), Array.from({ length: 7 }, (_, i) => `${RUN}-p${i}`).sort());
  });

  it("a cursor still works after the row it points at is deleted", async () => {
    for (let i = 1; i <= 3; i++) {
      await logEvent({ category: "http", event: "t.del", outcome: "info", statusCode: 200, message: `${DEL} ${i}`, requestId: `${RUN}-del${i}` });
    }
    const first = await list(`q=${DEL}&limit=1`);
    assert.equal(first.items.length, 1);
    assert.ok(first.next_cursor, "a cursor is returned");
    const deletedId = first.items[0].id;
    const rest = first.items[0].request_id;
    await q("DELETE FROM public.system_logs WHERE id = $1", [deletedId]);
    const next = await list(`q=${DEL}&limit=5&cursor=${encodeURIComponent(first.next_cursor)}`);
    assert.ok(!requestIds(next.items).includes(rest));
    assert.deepEqual(requestIds(next.items), [`${RUN}-del1`, `${RUN}-del2`, `${RUN}-del3`].filter((r) => r !== rest).sort());
  });

  it("limit above 500 is capped, not rejected", async () => {
    assert.equal((await getAuthed("/admin/api/logs?limit=1000")).status, 200);
  });

  it("list rows omit details", async () => {
    const r = await getAuthed(`/admin/api/logs?q=${M}&limit=1`);
    assert.equal(r.status, 200);
    assert.ok(!("details" in r.body.items[0]), "list rows omit details");
  });

  // ---- 4. data exposure

  it("secret-like keys in details are redacted in the stored row, the API and the export", async () => {
    const secrets = ["Hunter2-PW-x", "654321", "tok_LIVE_abcdef123456", "Bearer abc.def.ghi", "sk_live_1234567890", "918273", "zzzzzzzz-cookie", "eyJservicerole.payload"];
    await logEvent({
      category: "auth", event: "t.sec", outcome: "info", statusCode: 200, message: `${SEC} stored`, requestId: `${RUN}-sec`,
      details: {
        password: secrets[0], otp: secrets[1], token: secrets[2], authorization: secrets[3], api_key: secrets[4],
        code: secrets[5], cookie: secrets[6], service_role: secrets[7],
        nested: { secret: "nested-secret-value", items: [{ refresh_token: "rt-value-123" }], note: "ok" },
        phone: "9876543210", email: "alice@example.com", item: "ok",
      },
    });
    const [row] = await q("SELECT details::text AS d FROM public.system_logs WHERE request_id = $1", [`${RUN}-sec`]);
    for (const v of [...secrets, "nested-secret-value", "rt-value-123"]) assert.ok(!row.d.includes(v), "raw stored row must not hold " + v.slice(0, 4));

    const id = (await list(`q=${SEC}&limit=1`)).items[0].id;
    const one = await getAuthed(`/admin/api/logs/${id}`);
    assert.equal(one.status, 200);
    const body = JSON.stringify(one.body);
    for (const v of [...secrets, "nested-secret-value", "rt-value-123"]) assert.ok(!body.includes(v), "API must not return " + v.slice(0, 4));
    assert.equal(one.body.details.password, "[redacted]");
    assert.equal(one.body.details.otp, "[redacted]");
    assert.equal(one.body.details.token, "[redacted]");
    assert.equal(one.body.details.authorization, "[redacted]");
    assert.equal(one.body.details.api_key, "[redacted]");
    assert.equal(one.body.details.nested.secret, "[redacted]");
    assert.equal(one.body.details.nested.items[0].refresh_token, "[redacted]");
    assert.equal(one.body.details.phone, "******3210", "phone is masked");
    assert.equal(one.body.details.email, "a***@example.com", "email is masked");
    assert.equal(one.body.details.item, "ok", "non-secret keys are kept");
    assert.equal(one.body.details.nested.note, "ok");

    const exp = await fetch(`${base}/admin/api/logs/export?q=${SEC}&format=json`, { headers: { Cookie: `sl_admin=${adminToken}` } });
    const expText = await exp.text();
    for (const v of secrets) assert.ok(!expText.includes(v), "export must not return " + v.slice(0, 4));
  });

  it("free-text messages that carry OTP-like or bearer values are scrubbed", { todo: "BUG (functions/_shared/system-log.js scrubText): only e-mails and 9+ digit runs are masked; a 6-digit OTP or a Bearer token in message text is stored as is" }, async () => {
    await logEvent({ category: "otp.sms", event: "t.msg", outcome: "info", statusCode: 200, message: `${SEC} otp 482913 bearer Bearer abc.def.ghi`, requestId: `${RUN}-msg` });
    const body = JSON.stringify((await list(`q=${SEC}&limit=50`)).items);
    assert.ok(!body.includes("482913"), "6-digit OTP in message must not be returned");
    assert.ok(!body.includes("abc.def.ghi"), "bearer token in message must not be returned");
  });

  it("CSV export neutralises formula prefixes, escapes quotes and keeps newlines inside quoted cells", async () => {
    // The message itself starts with the risky character. The request id carries the marker for the filter.
    const cases = [
      ["=1+1", "'=1+1"],
      ["+cmd|' /C calc'!A0", "'+cmd|' /C calc'!A0"],
      ["-2+3", "'-2+3"],
      ["@SUM(1+1)", "'@SUM(1+1)"],
      ["\tTAB", "'\tTAB"],
      ["\rCR", "'\rCR"],
      ["  =space-padded", "'  =space-padded"],
    ];
    for (let i = 0; i < cases.length; i++) {
      await logEvent({ category: "http", event: "t.fx", outcome: "failed", statusCode: 400, message: cases[i][0], requestId: `${RUN}-fx${i}` });
    }
    await logEvent({ category: "http", event: "t.fx", outcome: "failed", statusCode: 400, message: 'line1\nline2 "q", comma', requestId: `${RUN}-fxnl` });
    const res = await fetch(`${base}/admin/api/logs/export?q=${RUN}-fx&format=csv`, { headers: { Cookie: `sl_admin=${adminToken}` } });
    const text = await res.text();
    for (const [, safe] of cases) {
      assert.ok(text.includes(`"${safe}"`), `formula cell ${JSON.stringify(safe)} must be neutralised`);
    }
    assert.ok(text.includes('"line1\nline2 ""q"", comma"'), "newline and comma stay inside one quoted cell, quotes doubled");
    assert.ok(!/(^|,)"?[=+\-@]/m.test(text.split("\r\n").slice(1).join("\r\n")), "no cell starts with a bare formula character");
  });

  // ---- 5. export

  it("JSON and CSV exports and the paged list agree on the row count for the same filter", async () => {
    const listed = await listAll(`q=${M}`);
    const jsonRes = await fetch(`${base}/admin/api/logs/export?q=${M}&format=json`, { headers: { Cookie: `sl_admin=${adminToken}` } });
    const json = await jsonRes.json();
    const csvRes = await fetch(`${base}/admin/api/logs/export?q=${M}&format=csv`, { headers: { Cookie: `sl_admin=${adminToken}` } });
    const csv = await csvRes.text();
    assert.equal(json.length, listed.length);
    assert.equal(listed.length, 5, "rows a to e");
    assert.deepEqual(requestIds(json), requestIds(listed));
    const csvIds = [...csv.matchAll(new RegExp(`"(${RUN}-[a-z0-9]+)"`, "g"))].map((m) => m[1]);
    assert.equal(csvIds.length, listed.length);
    assert.equal(new Set(csvIds).size, listed.length);
    assert.equal(jsonRes.headers.get("x-export-truncated"), "false");
  });

  it("export rejects an unknown format", async () => {
    assert.equal((await getAuthed("/admin/api/logs/export?format=xml")).status, 400);
    assert.equal((await getAuthed("/admin/api/logs/export?format=CSV")).status, 400);
  });

  it("exports are capped at 10000 rows and say so in X-Export-Truncated", async () => {
    await q(
      `INSERT INTO public.system_logs (ts, category, event, outcome, status_code, message, request_id)
       SELECT now(), 'http', 'cap.row', 'info', 200, $1, $2 || '-' || g FROM generate_series(1, 10001) g`,
      [CAP, `capro-${RUN}`]
    );
    try {
      const jsonRes = await fetch(`${base}/admin/api/logs/export?q=${CAP}&format=json`, { headers: { Cookie: `sl_admin=${adminToken}` } });
      assert.equal(jsonRes.status, 200);
      assert.equal(jsonRes.headers.get("x-export-truncated"), "true");
      const json = await jsonRes.json();
      assert.equal(json.length, 10000);

      const csvRes = await fetch(`${base}/admin/api/logs/export?q=${CAP}&format=csv`, { headers: { Cookie: `sl_admin=${adminToken}` } });
      assert.equal(csvRes.headers.get("x-export-truncated"), "true");
      const csv = await csvRes.text();
      // split gives: header, 10000 rows, then the empty string after the final CRLF
      assert.equal(csv.split("\r\n").length - 2, 10000, "10000 data rows");
    } finally {
      await q("DELETE FROM public.system_logs WHERE message = $1", [CAP]);
    }
  });

  // ---- 6. summary

  it("summary buckets, category totals, failure rates and top errors are correct", async () => {
    const ins = (ts, cat, event, status, outcome, message, n) =>
      q(
        `INSERT INTO public.system_logs (ts, category, event, status_code, outcome, message, request_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [ts, cat, event, status, outcome, message, `sumtest-${RUN}-${n}`]
      );
    await ins("2020-01-01T00:02:00Z", "auth", "s.1", 200, "success", "ok-1", 1);
    await ins("2020-01-01T00:10:00Z", "auth", "s.2", 500, "failed", "boom-A", 2);
    await ins("2020-01-01T00:16:00Z", "otp.sms", "s.3", 200, "success", "ok-2", 3);
    await ins("2020-01-01T00:59:00Z", "otp.sms", "s.4", 404, "info", "boom-B", 4);
    await ins("2020-01-01T00:59:30Z", "otp.sms", "s.5", 200, "failed", "boom-B", 5);

    const win = "from=2020-01-01T00:00:00Z&to=2020-01-01T01:00:00Z";
    const r = await getAuthed(`/admin/api/logs/summary?${win}&bucket=15m`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.buckets, [
      { start: "2020-01-01T00:00:00.000Z", total: 2, failed: 1, by_category: { auth: 2 } },
      { start: "2020-01-01T00:15:00.000Z", total: 1, failed: 0, by_category: { "otp.sms": 1 } },
      { start: "2020-01-01T00:45:00.000Z", total: 2, failed: 2, by_category: { "otp.sms": 2 } },
    ]);
    const sumBuckets = r.body.buckets.reduce((n, b) => n + b.total, 0);
    const sumCats = r.body.by_category.reduce((n, c) => n + c.total, 0);
    assert.equal(sumBuckets, 5);
    assert.equal(sumCats, 5, "category totals add up to the bucket totals");
    assert.deepEqual(r.body.by_category, [
      { category: "otp.sms", total: 3, failed: 2, failure_rate: 0.6667 },
      { category: "auth", total: 2, failed: 1, failure_rate: 0.5 },
    ]);
    assert.deepEqual(r.body.top_errors, [
      { message: "boom-B", category: "otp.sms", count: 2 },
      { message: "boom-A", category: "auth", count: 1 },
    ]);

    const hour = await getAuthed(`/admin/api/logs/summary?${win}&bucket=1h`);
    assert.deepEqual(hour.body.buckets, [
      { start: "2020-01-01T00:00:00.000Z", total: 5, failed: 3, by_category: { auth: 2, "otp.sms": 3 } },
    ]);

    assert.equal((await getAuthed(`/admin/api/logs/summary?${win}&bucket=7m`)).status, 400);
  });

  it("an empty window returns empty arrays, not an error", async () => {
    const r = await getAuthed("/admin/api/logs/summary?from=1990-01-01T00:00:00Z&to=1990-01-02T00:00:00Z&bucket=1d");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.buckets, []);
    assert.deepEqual(r.body.by_category, []);
    assert.deepEqual(r.body.top_errors, []);
  });

  it("a summary window with too many buckets is refused", async () => {
    const r = await getAuthed("/admin/api/logs/summary?from=2020-01-01T00:00:00Z&to=2020-01-05T00:00:00Z&bucket=1m");
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: "window_too_large" });
  });

  // ---- 7. providers

  it("providers/status returns only configured providers and never echoes an env secret", async () => {
    const r = await getAuthed("/admin/api/providers/status");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body));
    assert.deepEqual(r.body.map((p) => p.name), configuredProviders().map((p) => p.name));
    for (const p of r.body) {
      assert.deepEqual(Object.keys(p).sort(), ["checked_at", "configured", "last_error", "last_failure_at", "last_success_at", "latency_ms", "name", "reachable"].sort());
      assert.equal(typeof p.configured, "boolean");
      // Tests run in dry-run mode, so nothing is live and no network call is made.
      assert.equal(p.configured, false);
      assert.equal(p.reachable, null);
    }
    const body = JSON.stringify(r.body);
    for (const [name, value] of Object.entries(process.env)) {
      if (value && value.length >= 8) assert.ok(!body.includes(value), `response must not contain the value of ${name}`);
    }
    assert.ok(!body.includes(ADMIN_KEY), "response must not contain the admin key");
    assert.doesNotMatch(body, /https?:\/\//, "no URLs in the response");
  });

  it("the 60 second cache returns the same result (same checked_at) on a second call", async () => {
    _resetProviderStatusCache();
    const first = await getAuthed("/admin/api/providers/status");
    const second = await getAuthed("/admin/api/providers/status");
    assert.equal(first.status, 200);
    assert.deepEqual(second.body, first.body);
    assert.ok(first.body.length === 0 || first.body[0].checked_at);
    assert.equal(first.body[0]?.checked_at, second.body[0]?.checked_at);
  });

  it("a failing provider reports reachable false, a short last_error and no stack", async () => {
    const saved = { MAIL_MODE: process.env.MAIL_MODE, SMTP_HOST: process.env.SMTP_HOST, SMTP_PORT: process.env.SMTP_PORT };
    // Port 1 on loopback refuses connections at once. verify() only connects and logs in; no mail is sent.
    process.env.MAIL_MODE = "smtp";
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = "1";
    _resetProviderStatusCache();
    try {
      const r = await getAuthed("/admin/api/providers/status");
      assert.equal(r.status, 200);
      const smtp = r.body.find((p) => p.name === "SMTP");
      assert.ok(smtp, "SMTP is listed");
      assert.equal(smtp.configured, true);
      assert.equal(smtp.reachable, false);
      assert.ok(typeof smtp.last_error === "string" && smtp.last_error.length > 0 && smtp.last_error.length <= 40, smtp.last_error);
      assert.doesNotMatch(smtp.last_error, /\n|\bat\b|Error:/);
      assert.doesNotMatch(JSON.stringify(r.body), /127\.0\.0\.1|\n\s+at /);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      _resetProviderStatusCache();
    }
  });

  // ---- 8. error handling

  it("a database error returns a generic 500 with no SQL text", async () => {
    const realQuery = pool.query;
    pool.query = function (text, params) {
      if (typeof text === "string" && text.trimStart().startsWith("SELECT") && text.includes("system_logs")) {
        return Promise.reject(new Error('relation "public.system_logs" does not exist (SELECT id FROM public.system_logs)'));
      }
      return realQuery.call(pool, text, params);
    };
    try {
      const r = await getAuthed("/admin/api/logs");
      assert.equal(r.status, 500);
      assert.deepEqual(r.body, { error: "internal_error" });
      const s = JSON.stringify(r.body);
      assert.doesNotMatch(s, /system_logs|relation|SELECT|stack/i);
    } finally {
      pool.query = realQuery;
    }
    assert.equal((await getAuthed("/admin/api/logs?limit=1")).status, 200, "recovers after the error");
  });

  // ---- 2. brute force (last: it blocks logins from 127.0.0.1 for 10 minutes, and this test resets that)

  it("5 failures block login with 429; the 429 is the same whether the key was right or wrong", async () => {
    _testHooks.failures.clear();
    for (let i = 0; i < 5; i++) {
      // A different spoofed X-Forwarded-For on every attempt. No proxy is trusted, so these must not count separately.
      const r = await login(`wrong-${i}-${RUN}`, { "X-Forwarded-For": `203.0.113.${i + 10}` });
      assert.equal(r.status, 401, `failure ${i + 1}`);
    }
    const wrong = await login("definitely-wrong", { "X-Forwarded-For": "198.51.100.7" });
    const right = await login(ADMIN_KEY, { "X-Forwarded-For": "198.51.100.8" });
    assert.equal(wrong.status, 429);
    assert.equal(right.status, 429, "the right key is blocked too");
    assert.equal(wrong.text, right.text, "the 429 body does not reveal whether the key was right");
    assert.equal(wrong.body.error, "too_many_attempts");
    assert.equal(right.setCookie, "");
    assert.equal((await getAuthed("/admin/api/logs")).status, 200, "an existing session still works");
  });

  it("the block lifts once the failures are more than 10 minutes old", async () => {
    const aged = (ageMs) => {
      for (const [ip, list] of _testHooks.failures) _testHooks.failures.set(ip, list.map(() => Date.now() - ageMs));
    };
    aged(ms(9));
    assert.equal((await login(ADMIN_KEY)).status, 429, "still blocked at 9 minutes");
    aged(ms(10) + 1000);
    const r = await login(ADMIN_KEY);
    assert.equal(r.status, 200, "unblocked after 10 minutes");
    assert.match(r.setCookie, /sl_admin=/);
  });
});
