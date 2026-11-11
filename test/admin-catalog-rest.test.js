import "./helpers.js"; // loads .env and the test-DB guard before the app's pool is created
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import jwt from "jsonwebtoken";
import { createApp } from "../src/app.js";
import { createHttpServer } from "../src/http-server.js";
import { q } from "./helpers.js";
import { pool } from "../functions/_shared/db.js";

// The admin catalog screens (courses, categories, subjects, popular subjects, batches, explore by goal, featured
// courses, content audit) call these REST paths with supabase-js. Each test uses rows named QA-ADMIN- and removes them.
const TAG = "QA-ADMIN-" + crypto.randomBytes(3).toString("hex");
const SINGLE = "application/vnd.pgrst.object+json";

describe("admin catalog over /rest/v1", () => {
  let server;
  let base;
  let admin;
  let student;
  const ZERO = "00000000-0000-0000-0000-000000000000";

  const rest = async (method, path, { body, single = false, rep = false, token, count = false } = {}) => {
    const headers = {
      apikey: "anon-placeholder",
      Authorization: `Bearer ${token ?? admin.access}`,
      "Content-Type": "application/json",
    };
    if (rep) headers.Prefer = "return=representation";
    else if (method !== "GET" && method !== "POST") headers.Prefer = "return=minimal";
    if (single) headers.Accept = SINGLE;
    if (count) headers.Prefer = [headers.Prefer, "count=exact"].filter(Boolean).join(",");
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json, range: res.headers.get("content-range") };
  };

  before(async () => {
    server = createHttpServer(createApp()).listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
    // Test users are inserted directly (the signup path is not what these tests cover). Admin is granted via user_roles.
    const mk = async (label) => {
      const id = crypto.randomUUID();
      await q("INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at) VALUES ($1, $2, 'x', now(), '{}'::jsonb, now(), now())", [id, `${label}-${id}@example.test`]);
      await q("INSERT INTO public.profiles (id, full_name, email) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING", [id, TAG + " " + label, `${label}-${id}@example.test`]);
      const access = jwt.sign({ sub: id, role: "authenticated", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 }, process.env.JWT_SECRET);
      return { id, access };
    };
    admin = await mk("admin");
    student = await mk("student");
    await q("INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING", [admin.id]);
  });

  after(async () => {
    await q("DELETE FROM public.batches WHERE name LIKE 'QA-ADMIN-%'");
    await q("DELETE FROM public.course_subjects WHERE course_id IN (SELECT id FROM public.courses WHERE name LIKE 'QA-ADMIN-%')");
    await q("DELETE FROM public.course_categories WHERE course_id IN (SELECT id FROM public.courses WHERE name LIKE 'QA-ADMIN-%')");
    await q("DELETE FROM public.courses WHERE name LIKE 'QA-ADMIN-%'");
    await q("DELETE FROM public.category_goals WHERE category_id IN (SELECT id FROM public.categories WHERE name LIKE 'QA-ADMIN-%')");
    await q("DELETE FROM public.categories WHERE name LIKE 'QA-ADMIN-%'");
    await q("DELETE FROM public.popular_subjects WHERE name LIKE 'QA-ADMIN-%'");
    await q("DELETE FROM public.explore_by_goal WHERE name LIKE 'QA-ADMIN-%'");
    await q("DELETE FROM public.user_roles WHERE user_id = ANY($1::uuid[])", [[admin.id, student.id]]);
    await q("DELETE FROM public.profiles WHERE id = ANY($1::uuid[])", [[admin.id, student.id]]);
    await q("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", [[admin.id, student.id]]);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await pool.end();
  });

  it("accepts a long GET filter list (content audit batches 500 ids per request)", async () => {
    const ids = Array.from({ length: 500 }, () => crypto.randomUUID()).join(",");
    const r = await rest("GET", `/rest/v1/subject_topics?select=id,chapter_id,video_url&chapter_id=in.(${ids})`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body));
  });

  it("courses list: category join, ilike search, count and range (CoursesList / FeaturedCourses)", async () => {
    const r = await rest("GET", "/rest/v1/courses?select=id,name,slug,price_inr,is_active,created_at,course_categories!inner(category_id)&order=created_at.desc&offset=0&limit=5", {
      token: admin.access,
      count: true,
    });
    assert.equal(r.status, 200);
    assert.match(r.range, /^(\d+-\d+|\*)\/\d+$/);
    const s = await rest("GET", "/rest/v1/courses?select=id,name&name=ilike.*QA-ADMIN*&limit=5");
    assert.equal(s.status, 200);
  });

  it("get_category_descendants returns one row per category in the subtree", async () => {
    const parent = await rest("POST", "/rest/v1/categories?select=*", { body: { name: TAG + "-parent", slug: TAG + "-parent", level: 1, display_order: 0, is_active: true }, rep: true, single: true });
    assert.equal(parent.status, 201);
    const child = await rest("POST", "/rest/v1/categories?select=*", { body: { name: TAG + "-child", slug: TAG + "-child", level: 2, parent_id: parent.body.id, display_order: 0, is_active: true }, rep: true, single: true });
    assert.equal(child.status, 201);
    const r = await rest("POST", "/rest/v1/rpc/get_category_descendants", { body: { parent_uuid: parent.body.id } });
    assert.equal(r.status, 200);
    const ids = r.body.map((x) => x.category_id).sort();
    assert.deepEqual(ids, [parent.body.id, child.body.id].sort());
    const none = await rest("POST", "/rest/v1/rpc/get_category_descendants", { body: { parent_uuid: ZERO } });
    assert.deepEqual(none.body, []);
  });

  it("categories: create, update, single read with category_goals embed, goal links, delete", async () => {
    const goal = await rest("POST", "/rest/v1/explore_by_goal?select=*", { body: { name: TAG + "-goal", slug: TAG + "-goal", description: "x", icon: "", display_order: 0, is_active: true }, rep: true, single: true });
    assert.equal(goal.status, 201);
    const cat = await rest("POST", "/rest/v1/categories?select=*", { body: { name: TAG + "-cat", slug: TAG + "-cat", level: 1, display_order: 0, is_active: true }, rep: true, single: true });
    assert.equal(cat.status, 201);
    const link = await rest("POST", "/rest/v1/category_goals", { body: [{ category_id: cat.body.id, goal_id: goal.body.id }] });
    assert.equal(link.status, 201);
    const upd = await rest("PATCH", `/rest/v1/categories?id=eq.${cat.body.id}&select=*`, { body: { name: TAG + "-cat-2" }, rep: true, single: true });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.name, TAG + "-cat-2");
    const detail = await rest("GET", `/rest/v1/categories?select=*,category_goals(goal_id)&id=eq.${cat.body.id}`, { single: true });
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body.category_goals.map((g) => g.goal_id), [goal.body.id]);
    assert.equal((await rest("DELETE", `/rest/v1/category_goals?category_id=eq.${cat.body.id}`)).status, 204);
    assert.equal((await rest("DELETE", `/rest/v1/categories?id=eq.${cat.body.id}`)).status, 204);
    assert.equal((await rest("DELETE", `/rest/v1/explore_by_goal?id=eq.${goal.body.id}`)).status, 204);
  });

  it("courses: create, update, category links, delete (CourseForm / useAdminCourses)", async () => {
    const c = await rest("POST", "/rest/v1/courses?select=*", { body: { name: TAG + "-course", slug: TAG + "-course", price_inr: 0, is_active: false }, rep: true, single: true });
    assert.equal(c.status, 201);
    const u = await rest("PATCH", `/rest/v1/courses?id=eq.${c.body.id}&select=*`, { body: { name: TAG + "-course-2" }, rep: true, single: true });
    assert.equal(u.status, 200);
    const cc = await rest("POST", "/rest/v1/course_categories", { body: { course_id: c.body.id, category_id: ZERO } });
    assert.equal(cc.status, 409, "a category id that does not exist must be refused (foreign key)");
    assert.equal((await rest("DELETE", `/rest/v1/courses?id=eq.${c.body.id}`)).status, 204);
  });

  it("popular subjects: list embeds, create, update, course link, delete_subject_cascade (useDeleteSubject)", async () => {
    const list = await rest("GET", "/rest/v1/popular_subjects?select=id,name,slug,description,category_id,display_order,is_active,created_at,updated_at,server_ip,categories(id,name),course_subjects(courses(id,name))&order=display_order&limit=2", { single: false });
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body));
    const pc = await rest("POST", "/rest/v1/categories?select=*", { body: { name: TAG + "-subj-cat", slug: TAG + "-subj-cat", level: 1, display_order: 0, is_active: true }, rep: true, single: true });
    const s = await rest("POST", "/rest/v1/popular_subjects?select=*", { body: { name: TAG + "-subject", slug: TAG + "-subject", description: "x", category_id: pc.body.id, display_order: 0, is_active: true }, rep: true, single: true });
    assert.equal(s.status, 201);
    const u = await rest("PATCH", `/rest/v1/popular_subjects?id=eq.${s.body.id}&select=*`, { body: { display_order: 2 }, rep: true, single: true });
    assert.equal(u.status, 200);
    assert.equal(u.body.display_order, 2);
    const c = await rest("POST", "/rest/v1/courses?select=*", { body: { name: TAG + "-course-s", slug: TAG + "-course-s", price_inr: 0, is_active: false }, rep: true, single: true });
    const cs = await rest("POST", "/rest/v1/course_subjects?select=*", { body: { course_id: c.body.id, subject_id: s.body.id, display_order: 0 }, rep: true, single: true });
    assert.equal(cs.status, 201);
    const del = await rest("POST", "/rest/v1/rpc/delete_subject_cascade", { body: { p_subject_id: s.body.id } });
    assert.equal(del.status, 204);
    const gone = await rest("GET", `/rest/v1/popular_subjects?select=id&id=eq.${s.body.id}`);
    assert.deepEqual(gone.body, []);
    assert.deepEqual((await rest("GET", `/rest/v1/course_subjects?select=id&course_id=eq.${c.body.id}`)).body, []);
    await rest("DELETE", `/rest/v1/courses?id=eq.${c.body.id}`);
  });

  it("delete_subject_cascade is refused to non-admin callers", async () => {
    const r = await rest("POST", "/rest/v1/rpc/delete_subject_cascade", { body: { p_subject_id: ZERO }, token: student.access });
    assert.ok(r.status === 403 || r.status === 401, `expected 403/401, got ${r.status}`);
  });

  it("batches: create, update, detail embed, counter RPCs, delete (BatchForm / BatchDetails / BatchesList)", async () => {
    const c = await rest("POST", "/rest/v1/courses?select=*", { body: { name: TAG + "-course-b", slug: TAG + "-course-b", price_inr: 0, is_active: false }, rep: true, single: true });
    const b = await rest("POST", "/rest/v1/batches?select=*", { body: { name: TAG + "-batch", course_id: c.body.id, start_date: "2026-12-01", end_date: "2027-03-01", max_students: 10, current_students: 0, is_active: true }, rep: true, single: true });
    assert.equal(b.status, 201);
    const list = await rest("GET", `/rest/v1/batches?select=*,course:courses(id,name)&course_id=eq.${c.body.id}&order=created_at.desc`);
    assert.equal(list.status, 200);
    assert.equal(list.body[0].course.id, c.body.id);
    const u = await rest("PATCH", `/rest/v1/batches?id=eq.${b.body.id}&select=*`, { body: { max_students: 20 }, rep: true, single: true });
    assert.equal(u.body.max_students, 20);
    const detail = await rest("GET", `/rest/v1/batches?select=*,course:courses(id,name)&id=eq.${b.body.id}`, { single: true });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.course.name, TAG + "-course-b");
    assert.equal((await rest("POST", "/rest/v1/rpc/increment_batch_students", { body: { batch_id: b.body.id } })).status, 204);
    assert.equal((await rest("POST", "/rest/v1/rpc/decrement_batch_students", { body: { batch_id: b.body.id } })).status, 204);
    assert.equal((await rest("DELETE", `/rest/v1/batches?id=eq.${b.body.id}`)).status, 204);
    await rest("DELETE", `/rest/v1/courses?id=eq.${c.body.id}`);
  });

  it("explore by goal: create, update, delete (ExploreByGoalForm)", async () => {
    const g = await rest("POST", "/rest/v1/explore_by_goal?select=*", { body: { name: TAG + "-g2", slug: TAG + "-g2", description: "x", icon: "", display_order: 0, is_active: true }, rep: true, single: true });
    assert.equal(g.status, 201);
    const u = await rest("PATCH", `/rest/v1/explore_by_goal?id=eq.${g.body.id}&select=*`, { body: { display_order: 3 }, rep: true, single: true });
    assert.equal(u.body.display_order, 3);
    assert.equal((await rest("DELETE", `/rest/v1/explore_by_goal?id=eq.${g.body.id}`)).status, 204);
  });

  it("featured courses and course-category filter embeds (FeaturedCoursesManager, CoursesByCategory)", async () => {
    const r = await rest("GET", "/rest/v1/featured_courses?select=*,courses(id,name,slug,price_inr,original_price_inr,instructor_name,rating,student_count,duration_months,short_description,course_thumbnails(storage_url))&is_active=eq.true&order=display_order.asc");
    assert.equal(r.status, 200);
    const cc = await rest("GET", "/rest/v1/course_categories?select=course_id,courses!inner(id,name,slug,is_active)&courses.is_active=eq.true&limit=3");
    assert.equal(cc.status, 200);
  });

  it("teacher profiles with a named department FK embed and course subject embed (subject instructors, course subjects)", async () => {
    const t = await rest("GET", "/rest/v1/teacher_profiles?select=id,full_name,email,phone_number,department:departments!teacher_profiles_department_id_fkey(id,name)&order=full_name&limit=3");
    assert.equal(t.status, 200);
    const cs = await rest("GET", "/rest/v1/course_subjects?select=*,subject:popular_subjects(*)&order=display_order&limit=2");
    assert.equal(cs.status, 200);
  });

  it("content audit reads subjects, chapters and topics with paged range headers", async () => {
    const r = await rest("GET", "/rest/v1/courses?select=id,name,slug,category&is_active=eq.true&order=name");
    assert.equal(r.status, 200);
    const ch = await rest("GET", "/rest/v1/subject_chapters?select=id,subject_id&subject_id=in.(" + ZERO + ")");
    assert.equal(ch.status, 200);
    assert.deepEqual(ch.body, []);
  });
});
