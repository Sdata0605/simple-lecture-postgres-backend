// Admin People and HR screens (students, instructors, departments, timetable, live classes, recordings).
// Each test runs the same REST paths and embeds that the website's admin pages send through supabase-js,
// as a signed-in admin, and cleans up the rows it creates (names and emails carry the QA-ADMIN prefix).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { startServer, stopServer, call, q, makeUser, uniqueEmail } from "./helpers.js";
import { makeAdmin, bearer } from "./group02-harness.js";

const APIKEY = { apikey: "anon-placeholder" };
const json = (admin, extra = {}) => ({ ...APIKEY, ...bearer(admin.access), "Content-Type": "application/json", ...extra });
const REP = { Prefer: "return=representation" };
const SINGLE = { Accept: "application/vnd.pgrst.object+json" };
const MIN = { Prefer: "return=minimal" };
const tag = () => "QA-ADMIN " + crypto.randomBytes(3).toString("hex");

describe("admin people and HR screens", () => {
  let admin;
  let course;
  let subject;
  const cleanup = { departments: [], timetables: [], classes: [], recordings: [], instructors: [], students: [] };

  before(async () => {
    await startServer();
    admin = await makeAdmin();
    course = (await q("SELECT id FROM public.courses WHERE is_active = true ORDER BY created_at LIMIT 1"))[0]?.id;
    subject = (await q("SELECT id FROM public.popular_subjects ORDER BY name LIMIT 1"))[0]?.id;
  });

  after(async () => {
    if (cleanup.recordings.length) await q("DELETE FROM public.class_recordings WHERE id = ANY($1::uuid[])", [cleanup.recordings]);
    if (cleanup.classes.length) await q("DELETE FROM public.scheduled_classes WHERE id = ANY($1::uuid[])", [cleanup.classes]);
    if (cleanup.timetables.length) await q("DELETE FROM public.course_timetables WHERE id = ANY($1::uuid[])", [cleanup.timetables]);
    for (const id of cleanup.instructors) {
      await q("DELETE FROM public.instructor_subjects WHERE instructor_id = $1", [id]);
      await q("DELETE FROM public.teacher_profiles WHERE id = $1", [id]);
      await q("DELETE FROM public.user_roles WHERE user_id = $1 AND role = 'teacher'", [id]);
      await q("DELETE FROM auth.users WHERE id = $1", [id]);
    }
    for (const id of cleanup.students) {
      await q("DELETE FROM public.enrollments WHERE student_id = $1", [id]);
      await q("DELETE FROM public.profiles WHERE id = $1", [id]);
      await q("DELETE FROM auth.users WHERE id = $1", [id]);
    }
    if (cleanup.departments.length) await q("DELETE FROM public.departments WHERE id = ANY($1::uuid[])", [cleanup.departments]);
    await q("DELETE FROM public.user_roles WHERE user_id = $1 AND role = 'admin'", [admin.id]);
    await stopServer();
  });

  it("create-instructor links user_id, so the admin password reset works for the new instructor", async () => {
    const email = uniqueEmail("qa-admin-instr");
    const created = await call("POST", "/functions/v1/create-instructor", {
      body: { instructorData: { email, full_name: tag(), password: "Teach!ng123" } },
      headers: json(admin),
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = created.body.profile.id;
    cleanup.instructors.push(id);
    assert.equal(created.body.profile.user_id, id);

    const before = (await q("SELECT encrypted_password FROM auth.users WHERE id = $1", [id]))[0].encrypted_password;
    const reset = await call("POST", "/functions/v1/update-instructor-password", {
      body: { instructorId: id, newPassword: "Reset!Pass9" },
      headers: json(admin),
    });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    const after = (await q("SELECT encrypted_password FROM auth.users WHERE id = $1", [id]))[0].encrypted_password;
    assert.notEqual(after, before);
  });

  it("update-instructor-password refuses a non-admin caller", async () => {
    const user = await makeUser();
    const r = await call("POST", "/functions/v1/update-instructor-password", {
      body: { instructorId: admin.id, newPassword: "Reset!Pass9" },
      headers: json(user),
    });
    assert.equal(r.status, 401);
  });

  it("departments: admin creates, renames and deactivates a department", async () => {
    const created = await call("POST", "/rest/v1/departments", {
      body: { name: tag(), description: "QA", is_active: true },
      headers: json(admin, { ...REP, ...SINGLE }),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.id;
    cleanup.departments.push(id);

    const renamed = await call("PATCH", `/rest/v1/departments?id=eq.${id}`, { body: { name: tag() + " v2" }, headers: json(admin, MIN) });
    assert.equal(renamed.status, 204);

    const deactivated = await call("PATCH", `/rest/v1/departments?id=eq.${id}`, { body: { is_active: false }, headers: json(admin, MIN) });
    assert.equal(deactivated.status, 204);

    const row = await call("GET", `/rest/v1/departments?select=id,name,is_active,head:teacher_profiles!departments_head_of_department_fkey(id,full_name)&id=eq.${id}`, { headers: json(admin) });
    assert.equal(row.status, 200);
    assert.equal(row.body.length, 1);
    assert.equal(row.body[0].is_active, false);
    assert.match(row.body[0].name, /v2$/);
  });

  it("instructors: list embeds department and subjects, and bulk assign writes instructor_subjects", async () => {
    const email = uniqueEmail("qa-admin-instr");
    const created = await call("POST", "/functions/v1/create-instructor", {
      body: { instructorData: { email, full_name: tag(), password: "Teach!ng123" } },
      headers: json(admin),
    });
    assert.equal(created.status, 200);
    const id = created.body.profile.id;
    cleanup.instructors.push(id);

    const assign = await call("POST", "/rest/v1/instructor_subjects", {
      body: [{ instructor_id: id, subject_id: subject }],
      headers: json(admin, REP),
    });
    assert.equal(assign.status, 201, JSON.stringify(assign.body));

    const list = await call(
      "GET",
      `/rest/v1/teacher_profiles?select=*,department:departments!teacher_profiles_department_id_fkey(id,name),subjects:instructor_subjects(id,subject_id,subject:popular_subjects(id,name,category_id,categories(id,name)))&id=eq.${id}`,
      { headers: json(admin) }
    );
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body[0].subjects.length, 1);
    assert.equal(list.body[0].subjects[0].subject_id, subject);

    const bulk = await call(
      "GET",
      `/rest/v1/instructor_subjects?select=subject_id,instructor_id,teacher_profiles!instructor_subjects_instructor_id_fkey(id,full_name)&instructor_id=eq.${id}`,
      { headers: json(admin) }
    );
    assert.equal(bulk.status, 200);
    assert.equal(bulk.body[0].teacher_profiles.id, id);

    const replace = await call("DELETE", `/rest/v1/instructor_subjects?instructor_id=eq.${id}`, { headers: json(admin, MIN) });
    assert.equal(replace.status, 204);
  });

  it("timetable: admin inserts a recurring class and reads it with the instructor, subject, course and batch embeds", async () => {
    const instructor = (await q("SELECT id FROM public.teacher_profiles LIMIT 1"))[0]?.id;
    const ins = await call("POST", "/rest/v1/course_timetables", {
      body: {
        course_id: course, subject_id: subject, instructor_id: instructor, batch_id: null,
        day_of_week: 4, start_time: "09:00:00", end_time: "10:00:00", room_number: tag(),
        academic_year: "2026-27", valid_from: "2026-11-06", is_active: true,
      },
      headers: json(admin, { ...REP, ...SINGLE }),
    });
    assert.equal(ins.status, 201, JSON.stringify(ins.body));
    cleanup.timetables.push(ins.body.id);

    const read = await call(
      "GET",
      `/rest/v1/course_timetables?select=*,instructor:teacher_profiles(id,full_name),subject:popular_subjects(id,name),batch:batches(id,name),course:courses(id,name)&instructor_id=eq.${instructor}&is_active=eq.true&order=day_of_week&order=start_time`,
      { headers: json(admin) }
    );
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.ok(read.body.some((r) => r.id === ins.body.id));

    const soft = await call("PATCH", `/rest/v1/course_timetables?id=eq.${ins.body.id}`, { body: { is_active: false }, headers: json(admin, MIN) });
    assert.equal(soft.status, 204);
  });

  it("live classes: admin creates a scheduled class, goes live, then ends it", async () => {
    const instructor = (await q("SELECT id FROM public.teacher_profiles LIMIT 1"))[0]?.id;
    const ins = await call("POST", "/rest/v1/scheduled_classes", {
      body: [{
        course_id: course, subject_id: subject, subject: tag(), teacher_id: instructor,
        scheduled_at: new Date().toISOString(), duration_minutes: 60, is_live: true,
        live_started_at: new Date().toISOString(), is_cancelled: false,
      }],
      headers: json(admin, { ...REP, ...SINGLE }),
    });
    assert.equal(ins.status, 201, JSON.stringify(ins.body));
    const id = ins.body.id;
    cleanup.classes.push(id);

    const ended = await call("PATCH", `/rest/v1/scheduled_classes?id=eq.${id}`, {
      body: { is_live: false, live_ended_at: new Date().toISOString() },
      headers: json(admin, { ...REP, ...SINGLE }),
    });
    assert.equal(ended.status, 200, JSON.stringify(ended.body));
    assert.equal(ended.body.is_live, false);

    const list = await call(
      "GET",
      `/rest/v1/scheduled_classes?select=id,subject,scheduled_at,courses(id,name),popular_subjects(id,name),subject_chapters(id,title),subject_topics(id,title),teacher_profiles(id,full_name,avatar_url)&id=eq.${id}`,
      { headers: json(admin) }
    );
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
  });

  it("manual enrollment: admin enrolls a student, and the students list shows the enrollment embed", async () => {
    const student = await makeUser({ name: tag() });
    cleanup.students.push(student.id);
    const enroll = await call("POST", "/rest/v1/enrollments", {
      body: { student_id: student.id, course_id: course, is_active: true, enrolled_at: new Date().toISOString(), expires_at: new Date(Date.now() + 365 * 864e5).toISOString() },
      headers: json(admin, MIN),
    });
    assert.equal(enroll.status, 201, JSON.stringify(enroll.body));

    const list = await call(
      "GET",
      `/rest/v1/profiles?select=id,full_name,avatar_url,phone_number,created_at,enrollments(id,course_id,enrolled_at,is_active,courses(id,name))&id=eq.${student.id}`,
      { headers: json(admin) }
    );
    assert.equal(list.status, 200);
    assert.equal(list.body[0].enrollments.length, 1);
    assert.equal(list.body[0].enrollments[0].courses.id, course);

    const detail = await call(
      "GET",
      `/rest/v1/enrollments?select=id,course_id,enrolled_at,is_active,batch_id,courses(id,name,description,thumbnail_url),batches(id,name)&student_id=eq.${student.id}`,
      { headers: json(admin) }
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.body.length, 1);
  });

  it("recordings: admin lists recordings with course, subject, chapter, topic and scheduled-class embeds, and marks one for reprocessing", async () => {
    const ins = await call("POST", "/rest/v1/class_recordings", {
      body: [{ recording_title: tag(), processing_status: "failed", processing_error: "qa", recording_type: "qa" }],
      headers: json(admin, REP),
    });
    assert.equal(ins.status, 201, JSON.stringify(ins.body));
    const id = ins.body[0].id;
    cleanup.recordings.push(id);

    const list = await call(
      "GET",
      `/rest/v1/class_recordings?select=id,processing_status,recording_title,course:courses!course_id(id,name),subject:popular_subjects!subject_id(id,name),chapter:subject_chapters!chapter_id(id,title,chapter_number),topic:subject_topics!topic_id(id,title,topic_number),scheduled_class:scheduled_classes(id,scheduled_at,course_id,subject,course:courses(id,name),teacher:teacher_profiles(id,full_name))&order=created_at.desc`,
      { headers: { ...json(admin), Range: "0-19" } }
    );
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.ok(list.body.some((r) => r.id === id));

    const reprocess = await call("PATCH", `/rest/v1/class_recordings?id=eq.${id}`, {
      body: { processing_status: "pending", processing_error: null },
      headers: json(admin, MIN),
    });
    assert.equal(reprocess.status, 204);
    const single = await call("GET", `/rest/v1/class_recordings?select=bbb_recording_id,b2_original_path&id=eq.${id}`, { headers: json(admin, SINGLE) });
    assert.equal(single.status, 200);
  });

  it("sales leads: admin reads the newest leads with the page's limit", async () => {
    const r = await call("GET", "/rest/v1/sales_leads?select=*&order=created_at.desc&limit=500", { headers: json(admin) });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body));
  });
});
