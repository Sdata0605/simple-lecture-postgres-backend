import "./helpers.js"; // loads .env and guards the test database
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { pool } from "../functions/_shared/db.js";
import { router, buildPlan } from "../functions/study-timetable-ai/index.js";

// 2026-01-05 00:00 UTC is 05:30 in IST. JS getTimezoneOffset() for IST is -330.
const NOW = Date.UTC(2026, 0, 5, 0, 0, 0);
const IST = -330;
const day = (start, end) => ({ intervals: [{ label: "morning", start, end }] });
const topics = (n) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, title: `Topic ${i}`, subject_id: "s1" }));

describe("study-timetable-ai scheduler", () => {
  it("places topics inside the intervals and reports what did not fit", () => {
    const plan = buildPlan(
      { items: topics(3), deadline: "2026-01-06", weekday: day("06:00", "08:00"), saturday: { intervals: [] }, sunday: { intervals: [] }, tzOffsetMinutes: IST },
      NOW
    );
    // Each 120-minute interval fits one 80-minute topic, so two are placed and one is left over.
    assert.equal(plan.perTopicMin, 80);
    assert.equal(plan.sessions.length, 2);
    assert.equal(plan.unscheduled, 1);
    assert.equal(plan.sessions[0].scheduled_at, "2026-01-05T00:30:00.000Z"); // 06:00 IST
    assert.equal(plan.sessions[1].scheduled_at, "2026-01-06T00:30:00.000Z");
  });

  it("clips today's intervals so nothing is booked in the past", () => {
    const plan = buildPlan(
      { items: topics(1), deadline: "2026-01-05", weekday: day("05:00", "07:00"), saturday: { intervals: [] }, sunday: { intervals: [] }, tzOffsetMinutes: IST },
      NOW
    );
    assert.equal(plan.sessions.length, 1);
    // Now is 05:30 IST, so the session starts at 05:30 IST = 00:00 UTC.
    assert.equal(plan.sessions[0].scheduled_at, "2026-01-05T00:00:00.000Z");
  });

  it("uses the weekend pattern on Saturday", () => {
    // 2026-01-10 is a Saturday.
    const plan = buildPlan(
      { items: topics(1), deadline: "2026-01-10", startDate: "2026-01-10", weekday: { intervals: [] }, saturday: day("10:00", "11:00"), sunday: { intervals: [] }, tzOffsetMinutes: IST },
      NOW
    );
    assert.equal(plan.sessions.length, 1);
    assert.equal(plan.sessions[0].scheduled_at, "2026-01-10T04:30:00.000Z"); // 10:00 IST
  });
});

describe("study-timetable-ai route", () => {
  let server;
  let base;
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/functions/v1/study-timetable-ai", router);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await pool.end();
  });

  it("requires a bearer token", async () => {
    const r = await fetch(`${base}/functions/v1/study-timetable-ai`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "generate_plan" }),
    });
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: "Unauthorized" });
  });

  it("rejects an invalid token", async () => {
    const r = await fetch(`${base}/functions/v1/study-timetable-ai`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer not-a-jwt" },
      body: JSON.stringify({ action: "generate_plan" }),
    });
    assert.equal(r.status, 401);
  });
});
