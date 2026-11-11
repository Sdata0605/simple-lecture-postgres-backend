import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { nextRunAt, runDailyBlogOnce, startDailyBlogSchedule, stopDailyBlogSchedule, ensureSelfServiceKey } from "../functions/generate-blog-post/scheduler.js";

describe("daily blog schedule", () => {
  afterEach(() => stopDailyBlogSchedule());

  it("next run is 00:30 UTC today when it is still before that", () => {
    const next = nextRunAt(new Date("2026-11-06T00:10:00Z"));
    assert.equal(next.toISOString(), "2026-11-06T00:30:00.000Z");
  });

  it("next run is tomorrow 00:30 UTC once today's run has passed", () => {
    assert.equal(nextRunAt(new Date("2026-11-06T00:30:00Z")).toISOString(), "2026-11-07T00:30:00.000Z");
    assert.equal(nextRunAt(new Date("2026-11-06T18:00:00Z")).toISOString(), "2026-11-07T00:30:00.000Z");
  });

  it("crosses the month boundary", () => {
    assert.equal(nextRunAt(new Date("2026-11-30T23:59:00Z")).toISOString(), "2026-12-01T00:30:00.000Z");
  });

  it("a run posts to the route with the in-memory service key and reports success", async () => {
    const calls = [];
    const logs = [];
    const fakeFetch = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    };
    const r = await runDailyBlogOnce({ host: "127.0.0.1", port: 8787, fetchImpl: fakeFetch, log: (l) => logs.push(l) });
    assert.equal(r.ok, true);
    assert.equal(calls[0].url, "http://127.0.0.1:8787/functions/v1/generate-blog-post");
    assert.equal(calls[0].init.headers["x-service-key"], ensureSelfServiceKey());
    assert.match(logs[0], /blog\.daily\.created/);
  });

  it("a failed run is logged and does not throw", async () => {
    const logs = [];
    const failing = async () => new Response("AI API not configured", { status: 503 });
    const r = await runDailyBlogOnce({ host: "127.0.0.1", port: 8787, fetchImpl: failing, log: (l) => logs.push(l) });
    assert.equal(r.ok, false);
    assert.equal(r.status, 503);
    assert.match(logs[0], /blog\.daily\.failed/);
    const boom = async () => { throw new Error("connect refused"); };
    const r2 = await runDailyBlogOnce({ host: "127.0.0.1", port: 8787, fetchImpl: boom, log: () => {} });
    assert.equal(r2.ok, false);
  });

  it("start schedules the first run and stop clears it", () => {
    const t = startDailyBlogSchedule({ host: "127.0.0.1", port: 8787, fetchImpl: async () => new Response("", { status: 200 }), log: () => {} });
    assert.ok(t);
    stopDailyBlogSchedule();
  });
});
