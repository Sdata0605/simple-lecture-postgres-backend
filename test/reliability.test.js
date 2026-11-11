// Reliability and performance checks for the logging code (system-log, log-retention, request middleware).
// Pass/fail assertions are kept flakiness-independent. Timing numbers are printed as [reliability-metrics]
// lines and only guarded by generous upper bounds.
//
// The live backend on 8787 is read-only for this file: only GET /health is called there. All login-flow
// load (wrong-password POST /auth/v1/token) runs in-process through createApp() with dry-run mail/messages
// (helpers.js forces MAIL_MODE and MESSAGE_MODE to dry-run). No signups, OTPs, resets, or random phones.
//
// Writes only rows this file creates: system_logs rows tagged with this run's marker (request_id prefix),
// rows whose request_id came back in an X-Request-Id header from our own requests, and a scratch table
// that is dropped at the end. The purge test routes the real purge SQL to the scratch table.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { q } from "./helpers.js";
import { pool } from "../functions/_shared/db.js";
import { logEvent, fallbackRing } from "../functions/_shared/system-log.js";
import { purgeOldSystemLogs } from "../functions/_shared/log-retention.js";
import { createApp } from "../src/app.js";

const LIVE_HEALTH_URL = process.env.RELIABILITY_BASE_URL || "http://127.0.0.1:8787";
const RUN = crypto.randomUUID().slice(0, 8);
const SCRATCH = `rel_system_logs_${RUN}`;
const createdRequestIds = new Set();
const realQuery = pool.query;

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const summarize = (xs) => ({ n: xs.length, p50_ms: +pct(xs, 50).toFixed(2), p95_ms: +pct(xs, 95).toFixed(2) });
const metric = (name, value) => console.log(`[reliability-metrics] ${name} ${JSON.stringify(value)}`);

async function eventually(fn, ms = 2000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// Swaps pool.query for the duration of fn. The original is restored in finally.
async function withQuery(replacement, fn) {
  pool.query = replacement;
  try {
    return await fn();
  } finally {
    pool.query = realQuery;
  }
}

const outageQuery = () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:5432 (simulated outage)"));

// Silences the per-write db_write_failed lines (stdout via console.log) while fn runs.
async function quietErrors(fn) {
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

async function postToken(base, email, password) {
  const res = await fetch(`${base}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  await res.text();
  return { status: res.status, requestId: res.headers.get("x-request-id") };
}

const loginFailedCount = async (ids) =>
  Number((await q("SELECT count(*)::int AS n FROM public.system_logs WHERE event = 'login.failed' AND request_id = ANY($1)", [ids]))[0].n);

describe("logEvent does not block the request path", () => {
  it("returns a pending promise synchronously and resolves only after the insert", async () => {
    await withQuery(
      (_text, _params) => new Promise((r) => setTimeout(() => r({ rows: [], rowCount: 1 }), 300)),
      async () => {
        const t0 = performance.now();
        const p = logEvent({ category: "http", event: "reliability.nonblocking", outcome: "info", requestId: `${RUN}-nb` });
        const syncMs = performance.now() - t0;
        assert.equal(typeof p.then, "function");
        assert.ok(syncMs < 50, `logEvent blocked the caller for ${syncMs.toFixed(2)} ms`);
        let settled = false;
        p.then(() => (settled = true));
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(settled, false, "promise resolved before the insert finished");
        assert.equal(await p, true);
        metric("nonblocking_sync_ms", { value: +syncMs.toFixed(4) });
      }
    );
  });
});

describe("DB outage (in-process, pool.query replaced)", () => {
  it("resolves false, never throws, keeps the entry in the ring, and logs one db_write_failed line", async () => {
    // The db_write_failed line goes to stdout through console.log (system-log.js keepInRing).
    const outs = [];
    const origLog = console.log;
    const BODY = `body-${RUN}-must-not-print`;
    console.log = (...a) => outs.push(a.join(" "));
    let ok;
    try {
      ok = await withQuery(outageQuery, () =>
        logEvent({ category: "auth", event: "reliability.outage", outcome: "failed", message: BODY, requestId: `${RUN}-outage` })
      );
    } finally {
      console.log = origLog;
    }
    const errs = outs;
    assert.equal(ok, false);
    const last = fallbackRing.at(-1);
    assert.equal(last.event, "reliability.outage");
    assert.equal(last.request_id, `${RUN}-outage`);
    assert.match(last.db_error, /simulated outage/);
    const lines = errs.filter((l) => l.includes("system-log.db_write_failed"));
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(parsed).sort(), ["event", "level", "message", "step"]);
    assert.equal(parsed.message, "connect ECONNREFUSED 127.0.0.1:5432 (simulated outage)");
    assert.ok(!lines[0].includes(BODY), "log line leaked the message body");
  });

  it("keeps the fallback ring at 500 entries after 600 failed writes", async () => {
    let max = 0;
    await quietErrors(() =>
      withQuery(outageQuery, async () => {
        for (let i = 0; i < 600; i++) {
          await logEvent({ category: "http", event: "reliability.ring", requestId: `${RUN}-ring-${i}` });
          max = Math.max(max, fallbackRing.length);
        }
      })
    );
    assert.equal(max, 500);
    assert.equal(fallbackRing.length, 500);
    assert.equal(fallbackRing.at(-1).request_id, `${RUN}-ring-599`);
    assert.equal(fallbackRing[0].request_id, `${RUN}-ring-100`);
  });

  it("2000 failed writes keep memory bounded (ring stays at 500)", async () => {
    const big = "x".repeat(300);
    let deltaMb;
    await quietErrors(() =>
      withQuery(outageQuery, async () => {
        for (let i = 0; i < 200; i++) await logEvent({ category: "http", event: "reliability.mem", message: big });
        const before = process.memoryUsage().heapUsed;
        for (let i = 0; i < 2000; i++) await logEvent({ category: "http", event: "reliability.mem", message: big });
        const after = process.memoryUsage().heapUsed;
        deltaMb = (after - before) / 1024 / 1024;
      })
    );
    metric("memory_2000_failed_writes", { heap_delta_mb: +deltaMb.toFixed(2), ring_len: fallbackRing.length });
    assert.ok(deltaMb < 64, `heap grew ${deltaMb.toFixed(1)} MB`);
    assert.equal(fallbackRing.length, 500);
  });
});

describe("pool pressure on the shared pool", () => {
  it("50 concurrent logEvent calls do not starve GET /health", async () => {
    const app = createApp();
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const localBase = `http://127.0.0.1:${server.address().port}`;
    try {
      const burst = Array.from({ length: 50 }, (_, i) =>
        logEvent({ category: "frontend", event: "reliability.burst", outcome: "info", requestId: `${RUN}-burst-${i}`, durationMs: i })
      );
      const healthMs = [];
      const healthProbes = Array.from({ length: 10 }, async () => {
        const t0 = performance.now();
        const r = await fetch(`${localBase}/health`);
        await r.text();
        healthMs.push(performance.now() - t0);
        createdRequestIds.add(r.headers.get("x-request-id"));
        return r.status;
      });
      const [results, statuses] = await Promise.all([Promise.all(burst), Promise.all(healthProbes)]);
      assert.ok(results.every((v) => v === true), "some burst inserts failed");
      assert.ok(statuses.every((s) => s === 200));
      assert.ok(pool.totalCount <= 20, `pool grew to ${pool.totalCount}`);
      metric("health_during_burst_ms", summarize(healthMs));
      assert.ok(pct(healthMs, 95) < 5000, "GET /health p95 over 5 s during burst");
    } finally {
      await new Promise((r) => server.close(r));
      for (let i = 0; i < 50; i++) createdRequestIds.add(`${RUN}-burst-${i}`);
    }
  });
});

describe("retention purge", () => {
  it("deletes exactly the 14+ day old half of 20,000 rows in under 5 s, and plans the ts predicate", async () => {
    await q(`CREATE TABLE public.${SCRATCH} (LIKE public.system_logs EXCLUDING DEFAULTS INCLUDING INDEXES)`);
    try {
      await q(
        `INSERT INTO public.${SCRATCH} (id, ts, category, event, outcome, message, request_id)
         SELECT g,
                now() - CASE WHEN g <= 10000 THEN interval '20 days' ELSE interval '1 day' END - (g % 3600) * interval '1 second',
                'load-test', 'reliability.retention', 'info', $1, $1
           FROM generate_series(1, 20000) g`,
        [`load-test-${RUN}`]
      );
      await q(`ANALYZE public.${SCRATCH}`);

      // The real purge SQL, routed to the scratch table only for this call.
      let sawSql = "";
      pool.query = (text, params) => {
        sawSql = text;
        return realQuery.call(pool, text.replaceAll("public.system_logs", `public.${SCRATCH}`), params);
      };
      let deleted, elapsed;
      try {
        const t0 = performance.now();
        deleted = await purgeOldSystemLogs();
        elapsed = performance.now() - t0;
      } finally {
        pool.query = realQuery;
      }
      assert.match(sawSql, /ts < now\(\) - \(\$1::int \* interval '1 day'\)/);
      assert.equal(deleted, 10000);
      const left = (await q(`SELECT count(*)::int AS n, count(*) FILTER (WHERE ts < now() - interval '14 days')::int AS old FROM public.${SCRATCH}`))[0];
      assert.equal(left.n, 10000);
      assert.equal(left.old, 0);
      assert.ok(elapsed < 5000, `purge took ${elapsed.toFixed(0)} ms`);
      metric("purge_20000_half_old", { deleted, elapsed_ms: +elapsed.toFixed(1) });

      const plan = (sql) => q(`EXPLAIN ${sql}`).then((rows) => rows.map((r) => r["QUERY PLAN"]).join("\n"));
      const predicate = "DELETE FROM X WHERE ts < now() - ($1::int * interval '1 day')";
      metric("plan_scratch_50pct_old", await plan(predicate.replace("X", `public.${SCRATCH}`).replace("$1", "14")));

      // Realistic hourly run: only a small slice is older than 14 days.
      await q(
        `INSERT INTO public.${SCRATCH} (id, ts, category, event, outcome, message, request_id)
         SELECT g + 100000, now() - interval '15 days' - (g * interval '1 second'), 'load-test', 'reliability.retention', 'info', $1, $1
           FROM generate_series(1, 100) g`,
        [`load-test-${RUN}`]
      );
      await q(`ANALYZE public.${SCRATCH}`);
      metric("plan_scratch_small_slice", await plan(predicate.replace("X", `public.${SCRATCH}`).replace("$1", "14")));
      metric("plan_real_system_logs", await plan(predicate.replace("X", "public.system_logs").replace("$1", "14")));
    } finally {
      await q(`DROP TABLE IF EXISTS public.${SCRATCH}`);
    }
  });
});

describe("logEvent cost", () => {
  it("200 real inserts: sync call cost stays tiny, full insert cost reported", async () => {
    const syncMs = [];
    const totalMs = [];
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now();
      const p = logEvent({ category: "http", event: "reliability.cost", outcome: "info", requestId: `${RUN}-cost-${i}`, durationMs: i });
      syncMs.push(performance.now() - t0);
      assert.equal(await p, true);
      totalMs.push(performance.now() - t0);
    }
    metric("logEvent_sync_return", summarize(syncMs));
    metric("logEvent_full_insert", summarize(totalMs));
    assert.ok(pct(syncMs, 95) < 5, "logEvent sync return p95 over 5 ms");
  });
});

describe("GET /health on live 8787 (read-only) and login-flow load in-process (dry-run)", () => {
  let server;
  let localBase;
  // No account is created: the login flow uses an address with no account, which still logs login.failed
  // (auth-token.password.no_account). No signups, OTPs, resets, or phone numbers are used.
  const email = `rel.${RUN}@example.test`;

  before(async () => {
    const app = createApp();
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    localBase = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((r) => server.close(r));
    // Remove only rows whose request IDs came back from our own requests, and rows tagged with this run.
    const ids = [...createdRequestIds].filter(Boolean);
    if (ids.length) await q("DELETE FROM public.system_logs WHERE request_id = ANY($1)", [ids]);
    await q("DELETE FROM public.system_logs WHERE request_id LIKE $1", [`${RUN}-%`]);
  });

  it("GET /health on 8787: p50 and p95 over 30 sequential calls (read-only)", async () => {
    const healthMs = [];
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      const r = await fetch(`${LIVE_HEALTH_URL}/health`);
      await r.text();
      healthMs.push(performance.now() - t0);
      assert.equal(r.status, 200);
      createdRequestIds.add(r.headers.get("x-request-id"));
    }
    metric("GET_health_8787_30x", summarize(healthMs));
    assert.ok(pct(healthMs, 95) < 2000);
  });

  it("wrong-password POST /auth/v1/token in-process: p50 and p95 over 30 sequential calls", async () => {
    const tokenMs = [];
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      const r = await postToken(localBase, email, "Wrong!word9");
      tokenMs.push(performance.now() - t0);
      assert.equal(r.status, 400);
      createdRequestIds.add(r.requestId);
    }
    metric("POST_token_wrong_password_in_process_30x", summarize(tokenMs));
    assert.ok(pct(tokenMs, 95) < 2000);
  });

  it("50 parallel wrong-password logins in-process: all 400, distinct X-Request-Id, 50 login.failed rows", async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => postToken(localBase, email, "Wrong!word9")));
    assert.ok(results.every((r) => r.status === 400), `statuses: ${[...new Set(results.map((r) => r.status))]}`);
    const ids = results.map((r) => r.requestId);
    assert.ok(ids.every(Boolean), "missing X-Request-Id");
    assert.equal(new Set(ids).size, 50, "X-Request-Id values are not distinct");
    ids.forEach((id) => createdRequestIds.add(id));
    const count = await eventually(async () => {
      const n = await loginFailedCount(ids);
      return n === 50 ? n : null;
    }, 2000);
    const finalCount = count ?? (await loginFailedCount(ids));
    metric("concurrency_login_failed_rows", { expected: 50, found: finalCount });
    assert.equal(finalCount, 50);
  });
});
