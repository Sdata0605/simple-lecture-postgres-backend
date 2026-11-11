import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { q, uniqueEmail } from "./helpers.js";
import { pool } from "../functions/_shared/db.js";
import { sentMessages } from "../functions/_shared/mail.js";
import { createAuthUser } from "../functions/_shared/accounts.js";
import { router } from "../functions/send-timetable-reminders/index.js";

const CRON = "test-timetable-reminder-cron-key-not-real";
const tag = `tt5${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let server;
let base;
let user;
let courseId;
let timetableId;
let legacyId;
let channelId;

const run = () =>
  fetch(`${base}/functions/v1/send-timetable-reminders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CRON}` },
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

describe("send-timetable-reminders", () => {
  before(async () => {
    process.env.TIMETABLE_REMINDER_CRON_KEY = CRON;
    delete process.env.TIMETABLE_REMINDERS_ENABLED;
    const app = express();
    app.use(express.json());
    app.use("/functions/v1/send-timetable-reminders", router);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;

    user = await createAuthUser({ email: uniqueEmail("tt"), password: "Pass!word1", fullName: "Timetable Test" });
    [{ id: courseId }] = await q("INSERT INTO public.courses (name, slug) VALUES ($1, $2) RETURNING id", [`TT ${tag}`, `tt-${tag}`.toLowerCase()]);
    [{ id: timetableId }] = await q(
      "INSERT INTO public.study_timetables (student_id, course_id, mode) VALUES ($1, $2, 'auto') RETURNING id",
      [user.id, courseId]
    );
    // Legacy: starts in 15 minutes, no channel.
    [{ id: legacyId }] = await q(
      `INSERT INTO public.study_timetable_sessions
         (timetable_id, student_id, course_id, title, scheduled_at, duration_minutes, status)
       VALUES ($1, $2, $3, $4, now() + interval '15 minutes', 25, 'pending') RETURNING id`,
      [timetableId, user.id, courseId, `Legacy ${tag}`]
    );
  });

  after(async () => {
    delete process.env.TIMETABLE_REMINDERS_ENABLED;
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
    const r = await fetch(`${base}/functions/v1/send-timetable-reminders`, { method: "POST" });
    assert.equal(r.status, 401);
  });

  it("sends the legacy 15-minute email and marks the session", async () => {
    const r = await run();
    assert.equal(r.status, 200);
    assert.ok(r.body.processed >= 1);
    assert.ok(sentMessages.some((m) => m.to === user.email && /starts in 15 minutes/.test(m.subject)));
    const [row] = await q("SELECT reminder_sent_at FROM public.study_timetable_sessions WHERE id = $1", [legacyId]);
    assert.notEqual(row.reminder_sent_at, null);
  });

  it("sends a channel email for a due session once, when enabled", async () => {
    process.env.TIMETABLE_REMINDERS_ENABLED = "true";
    [{ id: channelId }] = await q(
      `INSERT INTO public.study_timetable_sessions
         (timetable_id, student_id, course_id, title, scheduled_at, duration_minutes, status, reminder_channel)
       VALUES ($1, $2, $3, $4, now() - interval '2 minutes', 20, 'pending', 'email') RETURNING id`,
      [timetableId, user.id, courseId, `Channel ${tag}`]
    );
    const first = await run();
    assert.equal(first.status, 200);
    assert.ok(first.body.channelEmails.sent >= 1);
    assert.ok(sentMessages.some((m) => m.to === user.email && /^Time to study Channel/.test(m.subject)));

    const again = sentMessages.filter((m) => m.to === user.email && /^Time to study/.test(m.subject)).length;
    await run();
    assert.equal(sentMessages.filter((m) => m.to === user.email && /^Time to study/.test(m.subject)).length, again);
  });
});
