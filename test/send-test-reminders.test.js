import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { q, uniqueEmail } from "./helpers.js";
import { pool } from "../functions/_shared/db.js";
import { sentMessages } from "../functions/_shared/mail.js";
import { createAuthUser } from "../functions/_shared/accounts.js";
import { router } from "../functions/send-test-reminders/index.js";

const CRON = "test-test-reminder-cron-key-not-real";
const tag = `tr5${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let server;
let base;
let user;
let courseId;
let timetableId;
let sessionId;

const run = () =>
  fetch(`${base}/functions/v1/send-test-reminders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CRON}` },
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

describe("send-test-reminders", () => {
  before(async () => {
    process.env.TIMETABLE_REMINDER_CRON_KEY = CRON;
    const app = express();
    app.use(express.json());
    app.use("/functions/v1/send-test-reminders", router);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;

    user = await createAuthUser({ email: uniqueEmail("tr"), password: "Pass!word1", fullName: "Test Reminder" });
    [{ id: courseId }] = await q("INSERT INTO public.courses (name, slug) VALUES ($1, $2) RETURNING id", [`TR ${tag}`, `tr-${tag}`.toLowerCase()]);
    [{ id: timetableId }] = await q(
      "INSERT INTO public.study_timetables (student_id, course_id, mode) VALUES ($1, $2, 'auto') RETURNING id",
      [user.id, courseId]
    );
    // Starts in 60 minutes, which falls in the 1-hour window.
    [{ id: sessionId }] = await q(
      `INSERT INTO public.study_timetable_sessions
         (timetable_id, student_id, course_id, title, scheduled_at, duration_minutes, session_type, status)
       VALUES ($1, $2, $3, $4, now() + interval '60 minutes', 30, 'test', 'pending') RETURNING id`,
      [timetableId, user.id, courseId, `Mock ${tag}`]
    );
  });

  after(async () => {
    await q("DELETE FROM public.study_timetable_sessions WHERE timetable_id = $1", [timetableId]);
    await q("DELETE FROM public.study_timetables WHERE id = $1", [timetableId]);
    await q("DELETE FROM public.courses WHERE id = $1", [courseId]);
    await q("DELETE FROM public.user_roles WHERE user_id = $1", [user.id]);
    await q("DELETE FROM public.profiles WHERE id = $1", [user.id]);
    await q("DELETE FROM auth.users WHERE id = $1", [user.id]);
    await new Promise((r) => server.close(r));
    await pool.end();
  });

  it("refuses callers without the cron key", async () => {
    const r = await fetch(`${base}/functions/v1/send-test-reminders`, { method: "POST" });
    assert.equal(r.status, 401);
  });

  it("sends the one-hour reminder once and records it", async () => {
    const r = await run();
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.checked, "number");
    assert.ok(sentMessages.some((m) => m.to === user.email && /in 1 hour/.test(m.subject)));
    const [row] = await q("SELECT reminder_1h_sent_at FROM public.study_timetable_sessions WHERE id = $1", [sessionId]);
    assert.notEqual(row.reminder_1h_sent_at, null);
  });

  it("does not send the same reminder again", async () => {
    const before = sentMessages.filter((m) => m.to === user.email).length;
    await run();
    assert.equal(sentMessages.filter((m) => m.to === user.email).length, before);
  });
});
