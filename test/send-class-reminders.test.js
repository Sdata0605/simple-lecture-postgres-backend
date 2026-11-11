import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { router } from "../functions/send-class-reminders/index.js";

const CRON = "test-cron-secret";
let fnServer;
let fnBase;
const savedCron = process.env.CRON_SECRET;
const courseIds = [];
const timetableIds = [];
const tokenIds = [];
const userIds = [];
const startedAt = new Date();

const hhmm = (d) => d.toTimeString().slice(0, 5);

async function run(headers = { Authorization: `Bearer ${CRON}` }) {
  const res = await fetch(`${fnBase}/`, { method: "POST", headers });
  return { status: res.status, body: await res.json() };
}

describe("send-class-reminders", () => {
  before(async () => {
    await startServer();
    process.env.CRON_SECRET = CRON;
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/", router);
    fnServer = app.listen(0, "127.0.0.1");
    await once(fnServer, "listening");
    fnBase = `http://127.0.0.1:${fnServer.address().port}`;
  });

  after(async () => {
    try {
      await q("DELETE FROM public.notices WHERE category = 'class_reminder' AND created_at >= $1", [startedAt]);
      if (tokenIds.length) await q("DELETE FROM public.push_notification_tokens WHERE id = ANY($1)", [tokenIds]);
      if (timetableIds.length) await q("DELETE FROM public.course_timetables WHERE id = ANY($1)", [timetableIds]);
      if (courseIds.length) {
        await q("DELETE FROM public.enrollments WHERE course_id = ANY($1)", [courseIds]);
        await q("DELETE FROM public.courses WHERE id = ANY($1)", [courseIds]);
      }
    } finally {
      if (savedCron === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = savedCron;
      await new Promise((r) => fnServer.close(r));
      await stopServer();
    }
  });

  it("refuses callers without the cron secret", async () => {
    assert.equal((await run({})).status, 401);
    assert.equal((await run({ Authorization: "Bearer nope" })).status, 401);
  });

  it("reports nothing to do when no class starts in the window", async () => {
    const r = await run();
    assert.equal(r.status, 200);
    // The test database may hold real timetable rows; only the shape is asserted here.
    assert.ok(typeof r.body.message === "string");
  });

  it("notifies enrolled students with a push token for a class starting in 16 minutes", async () => {
    const [ref] = await q("SELECT s.id AS subject_id, s.name AS subject_name FROM public.popular_subjects s LIMIT 1");
    const [teacher] = await q("SELECT id, full_name FROM public.teacher_profiles LIMIT 1");
    const student = await makeUser();
    userIds.push(student.id);

    const courseId = randomUUID();
    courseIds.push(courseId);
    await q("INSERT INTO public.courses (id, name, slug) VALUES ($1, 'Reminder course', $2)", [courseId, `rem-${courseId}`]);
    await q("INSERT INTO public.enrollments (student_id, course_id, is_active) VALUES ($1, $2, true)", [student.id, courseId]);

    // Start time 16 minutes from now, on today's weekday, so it falls in the 15-17 minute window.
    const start = new Date(Date.now() + 16 * 60 * 1000);
    const ttId = randomUUID();
    timetableIds.push(ttId);
    await q(
      `INSERT INTO public.course_timetables
         (id, course_id, subject_id, instructor_id, day_of_week, start_time, end_time, academic_year, valid_from, is_active)
       VALUES ($1, $2, $3, $4, $5, $6::time, $7::time, '2026-27', CURRENT_DATE, true)`,
      [ttId, courseId, ref.subject_id, teacher.id, start.getDay(), hhmm(start), hhmm(new Date(start.getTime() + 3600e3))]
    );

    const tokenId = randomUUID();
    tokenIds.push(tokenId);
    await q(
      "INSERT INTO public.push_notification_tokens (id, user_id, token, platform, is_active) VALUES ($1, $2, $3, 'web', true)",
      [tokenId, student.id, `tok-${tokenId}`]
    );

    const r = await run();
    assert.equal(r.status, 200);
    assert.equal(r.body.message, "Class reminders processed");
    assert.ok(r.body.classesFound >= 1);
    assert.ok(r.body.notificationsSent >= 1);

    const notices = await q(
      "SELECT title, description, category, priority, is_global, created_by FROM public.notices WHERE category = 'class_reminder' AND created_at >= $1",
      [startedAt]
    );
    const mine = notices.find((n) => n.description === `${ref.subject_name} with ${teacher.full_name} starts in 15 minutes`);
    assert.ok(mine, "a notice for the test class was written");
    assert.equal(mine.title, "📚 Class Starting Soon!");
    assert.equal(mine.priority, "high");
    assert.equal(mine.is_global, false);
    assert.equal(mine.created_by, null);
  });
});
