import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { q, uniqueEmail } from "./helpers.js";
import { pool } from "../functions/_shared/db.js";
import { createAuthUser } from "../functions/_shared/accounts.js";
import { issueSession } from "../functions/_shared/session.js";
import { router } from "../functions/send-verification-notification/index.js";

const SERVICE = "test-service-key-not-real-0004";
const tag = `vn5${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let server;
let base;
let student;
let teacher;
let categoryId;
let subjectId;
let chapterId;
let documentId;

const post = async (body, token) => {
  const r = await fetch(`${base}/functions/v1/send-verification-notification`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

async function makeUser(role) {
  const u = await createAuthUser({ email: uniqueEmail("vn"), password: "Pass!word1", fullName: "VN Test" });
  if (role !== "student") {
    await q("INSERT INTO public.user_roles (user_id, role) VALUES ($1, $2::app_role) ON CONFLICT DO NOTHING", [u.id, role]);
  }
  const session = await issueSession(u);
  return { id: u.id, email: u.email, access: session.access_token };
}

describe("send-verification-notification", () => {
  before(async () => {
    process.env.SERVICE_ROLE_KEY = SERVICE;
    const app = express();
    app.use(express.json());
    app.use("/functions/v1/send-verification-notification", router);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
    student = await makeUser("student");
    teacher = await makeUser("teacher");

    [{ id: categoryId }] = await q("INSERT INTO public.categories (name, slug, level) VALUES ($1, $2, 1) RETURNING id", [tag, tag]);
    [{ id: subjectId }] = await q("INSERT INTO public.popular_subjects (name, slug, category_id) VALUES ($1, $2, $3) RETURNING id", [`Subj ${tag}`, tag, categoryId]);
    [{ id: chapterId }] = await q(
      "INSERT INTO public.subject_chapters (subject_id, title, chapter_number, sequence_order) VALUES ($1, $2, 1, 1) RETURNING id",
      [subjectId, `Chap ${tag}`]
    );
    [{ id: documentId }] = await q(
      `INSERT INTO public.uploaded_question_documents (category_id, subject_id, chapter_id, uploaded_by, file_type, file_name, file_url)
       VALUES ($1, $2, $3, $4, 'pdf', $5, $6) RETURNING id`,
      [categoryId, subjectId, chapterId, student.id, `${tag}.pdf`, `https://example.test/${tag}.pdf`]
    );
  });

  after(async () => {
    await q("DELETE FROM public.verification_notifications WHERE document_id = $1", [documentId]);
    await q("DELETE FROM public.instructor_subjects WHERE subject_id = $1", [subjectId]);
    await q("DELETE FROM public.teacher_profiles WHERE id = $1", [teacher.id]);
    await q("DELETE FROM public.uploaded_question_documents WHERE id = $1", [documentId]);
    await q("DELETE FROM public.subject_chapters WHERE id = $1", [chapterId]);
    await q("DELETE FROM public.popular_subjects WHERE id = $1", [subjectId]);
    await q("DELETE FROM public.categories WHERE id = $1", [categoryId]);
    for (const u of [student, teacher]) {
      await q("DELETE FROM public.auth_refresh_tokens WHERE user_id = $1", [u.id]);
      await q("DELETE FROM public.user_roles WHERE user_id = $1", [u.id]);
      await q("DELETE FROM public.profiles WHERE id = $1", [u.id]);
      await q("DELETE FROM auth.users WHERE id = $1", [u.id]);
    }
    await new Promise((r) => server.close(r));
    await pool.end();
  });

  it("requires documentId and notificationType", async () => {
    const r = await post({ documentId }, SERVICE);
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: "documentId and notificationType are required" });
  });

  it("refuses a student", async () => {
    const r = await post({ documentId, notificationType: "verification_needed" }, student.access);
    assert.equal(r.status, 401);
  });

  it("returns 500 for an unknown document", async () => {
    const r = await post({ documentId: "00000000-0000-4000-8000-0000000000fe", notificationType: "issues_found" }, SERVICE);
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: "Document not found" });
  });

  it("reports no instructors when none are assigned", async () => {
    const r = await post({ documentId, notificationType: "verification_needed" }, SERVICE);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { message: "No instructors assigned to this subject", notificationsSent: 0 });
  });

  it("notifies each assigned instructor", async () => {
    await q("INSERT INTO public.teacher_profiles (id, full_name, email, user_id) VALUES ($1, 'VN Teacher', $2, $1)", [teacher.id, teacher.email]);
    await q("INSERT INTO public.instructor_subjects (instructor_id, subject_id) VALUES ($1, $2)", [teacher.id, subjectId]);
    const r = await post({ documentId, notificationType: "verification_needed" }, teacher.access);
    assert.equal(r.status, 200);
    assert.equal(r.body.notificationsSent, 1);
    assert.match(r.body.message, /Notifications sent to 1 instructor/);
    const rows = await q("SELECT message, notification_type, is_read FROM public.verification_notifications WHERE document_id = $1", [documentId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].notification_type, "verification_needed");
    assert.equal(rows[0].is_read, false);
    assert.match(rows[0].message, /Verification needed\./);
  });
});
