import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { router } from "../functions/record-daily-attendance/index.js";

let fnServer;
let fnBase;
const userIds = [];

async function hit(qs = "", headers = {}) {
  const res = await fetch(`${fnBase}/${qs}`, { method: "POST", headers });
  return { status: res.status, body: await res.json() };
}
const isoDaysAgo = (n) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString().split("T")[0];
const bearer = (u) => ({ Authorization: `Bearer ${u.access}` });

async function user() {
  const u = await makeUser();
  userIds.push(u.id);
  return u;
}

describe("record-daily-attendance", () => {
  before(async () => {
    await startServer();
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/", router);
    fnServer = app.listen(0, "127.0.0.1");
    await once(fnServer, "listening");
    fnBase = `http://127.0.0.1:${fnServer.address().port}`;
  });

  after(async () => {
    try {
      if (userIds.length) await q("DELETE FROM public.daily_login_attendance WHERE student_id = ANY($1)", [userIds]);
    } finally {
      await new Promise((r) => fnServer.close(r));
      await stopServer();
    }
  });

  it("answers OPTIONS", async () => {
    const r = await fetch(`${fnBase}/`, { method: "OPTIONS" });
    assert.equal(r.status, 200);
  });

  it("401 without an Authorization header", async () => {
    const r = await hit();
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "No authorization header");
  });

  it("401 for a forged token", async () => {
    const r = await hit("", { Authorization: "Bearer not.a.token" });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "Unauthorized");
  });

  it("first visit today creates the record and marks attendance", async () => {
    const u = await user();
    const r = await hit("?device_type=android", bearer(u));
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.today.marked, true);
    assert.equal(r.body.today.login_count, 1);
    assert.ok(r.body.today.first_login_at);

    const [row] = await q("SELECT device_type, login_count FROM public.daily_login_attendance WHERE student_id = $1", [u.id]);
    assert.equal(row.device_type, "android");
    assert.equal(row.login_count, 1);
  });

  it("a second visit the same day increments login_count, keeps first_login_at", async () => {
    const u = await user();
    const first = await hit("", bearer(u));
    const second = await hit("", bearer(u));
    assert.equal(second.status, 200);
    assert.equal(second.body.today.login_count, 2);
    assert.equal(second.body.today.first_login_at, first.body.today.first_login_at);
    const rows = await q("SELECT count(*)::int n FROM public.daily_login_attendance WHERE student_id = $1", [u.id]);
    assert.equal(rows[0].n, 1);
  });

  it("stats: a streak counts consecutive days ending today, and the last 7 days are listed", async () => {
    const u = await user();
    await q(
      "INSERT INTO public.daily_login_attendance (student_id, attendance_date) VALUES ($1, $2::date), ($1, $3::date)",
      [u.id, isoDaysAgo(1), isoDaysAgo(2)]
    );
    const r = await hit("", bearer(u));
    assert.equal(r.status, 200);
    assert.equal(r.body.stats.current_streak, 3);
    assert.equal(r.body.stats.last_7_days.length, 7);
    assert.equal(r.body.stats.last_7_days[0].date, isoDaysAgo(0));
    assert.equal(r.body.stats.last_7_days[0].present, true);
    assert.equal(r.body.stats.last_7_days[6].present, false);
    assert.ok(r.body.stats.days_present_this_month >= 1);
    assert.ok(r.body.stats.days_present_this_month <= r.body.stats.total_days_this_month);
  });

  it("stats: a gap breaks the streak", async () => {
    const u = await user();
    await q(
      "INSERT INTO public.daily_login_attendance (student_id, attendance_date) VALUES ($1, $2::date)",
      [u.id, isoDaysAgo(2)]
    );
    const r = await hit("", bearer(u));
    assert.equal(r.body.stats.current_streak, 1);
  });
});
