// Tests for the PostgREST-compatible /rest/v1 layer (functions/rest + functions/_shared/rest).
// Row access is decided by Supabase's row-level security policies in the database, so most expectations here are
// what those policies return for each caller: anon, a student, an admin, and the service key.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startServer, stopServer, base, makeUser, q, expiredJwt } from "./helpers.js";

// The UI sends the anon key in apikey. The value only has to be distinct from a user token here.
const ANON = "rest-test-anon-key";
// Service key for backend-internal callers. Read from env at request time, so it is set before the server starts.
const SERVICE = `rest-test-service-${randomUUID()}`;
process.env.SERVICE_KEY = SERVICE;
const UUID_RE = /^[0-9a-f-]{36}$/;

async function rest(method, path, { token, body, headers = {} } = {}) {
  const h = { apikey: ANON, ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const res = await fetch(base + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, headers: res.headers, body: json };
}

const tag = `rest${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const state = {};

before(async () => {
  await startServer();
  state.a = await makeUser();
  state.b = await makeUser();
  state.admin = await makeUser();
  await q("INSERT INTO user_roles (user_id, role) VALUES ($1, 'admin'::app_role)", [state.admin.id]);

  const [c1] = await q(
    "INSERT INTO courses (name, slug, is_active) VALUES ($1, $2, true) RETURNING id, name, slug",
    [`Rest Course One ${tag}`, `${tag}-one`]
  );
  const [c2] = await q(
    "INSERT INTO courses (name, slug, is_active) VALUES ($1, $2, true) RETURNING id, name, slug",
    [`Rest Course Two ${tag}`, `${tag}-two`]
  );
  const [hidden] = await q(
    "INSERT INTO courses (name, slug, is_active) VALUES ($1, $2, false) RETURNING id, name, slug",
    [`Rest Hidden ${tag}`, `${tag}-hidden`]
  );
  state.c1 = c1;
  state.c2 = c2;
  state.hidden = hidden;

  // A owns two cart rows, B owns one.
  await q("INSERT INTO cart_items (user_id, course_id) VALUES ($1, $2), ($1, $3), ($4, $3)", [
    state.a.id,
    c1.id,
    c2.id,
    state.b.id,
  ]);
  // Each student is enrolled in one course: A in c1, B in c2.
  await q("INSERT INTO enrollments (student_id, course_id) VALUES ($1, $2), ($3, $4)", [
    state.a.id,
    c1.id,
    state.b.id,
    c2.id,
  ]);
});

after(async () => {
  try {
    await q("DELETE FROM enrollments WHERE student_id = ANY($1::uuid[])", [[state.a.id, state.b.id]]);
    await q("DELETE FROM cart_items WHERE user_id = ANY($1::uuid[])", [[state.a.id, state.b.id]]);
    await q("DELETE FROM user_roles WHERE user_id = $1", [state.admin.id]);
    await q("DELETE FROM courses WHERE id = ANY($1::uuid[])", [[state.c1.id, state.c2.id, state.hidden.id]]);
  } finally {
    await stopServer();
  }
});

test("anonymous public read of an active course works and inactive rows stay hidden", async () => {
  const r = await rest("GET", `/rest/v1/courses?select=id,name&id=in.(${state.c1.id},${state.hidden.id})`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((x) => x.id), [state.c1.id]);
  assert.equal(r.body[0].name, state.c1.name);
});

test("anonymous read of a table whose policy needs a login returns no rows", async () => {
  // Policies: ai_settings is admin-only except "Allow public read of hero_video setting" (anon, hero_video only).
  // cart_items is "Users view own cart" (auth.uid() = user_id). With no user, auth.uid() is null and RLS filters
  // everything out. PostgREST answers 200 with an empty array.
  const settings = await rest("GET", "/rest/v1/ai_settings?select=setting_key");
  assert.equal(settings.status, 200);
  assert.ok(settings.body.every((r) => r.setting_key === "hero_video"), "anon may read only the hero_video setting");
  const carts = await rest("GET", "/rest/v1/cart_items?select=id");
  assert.equal(carts.status, 200);
  assert.deepEqual(carts.body, []);
  const enrolled = await rest("GET", "/rest/v1/enrollments?select=id");
  assert.equal(enrolled.status, 200);
  assert.deepEqual(enrolled.body, []);
});

test("requests with no key or a bad JWT are refused", async () => {
  const none = await fetch(`${base}/rest/v1/courses?select=id`);
  assert.equal(none.status, 401);
  const bad = await rest("GET", "/rest/v1/cart_items?select=id", { token: "not.a.jwt" });
  assert.equal(bad.status, 401);
  const expired = await rest("GET", "/rest/v1/cart_items?select=id", { token: expiredJwt(state.a.id) });
  assert.equal(expired.status, 401);
});

test("a user reads only their own rows", async () => {
  const r = await rest("GET", "/rest/v1/cart_items?select=user_id,course_id", { token: state.a.access });
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 2);
  assert.ok(r.body.every((row) => row.user_id === state.a.id));

  const rb = await rest("GET", "/rest/v1/cart_items?select=user_id", { token: state.b.access });
  assert.equal(rb.body.length, 1);
  assert.equal(rb.body[0].user_id, state.b.id);
});

test("a non-admin sees no rows of an admin-only table", async () => {
  const r = await rest("GET", "/rest/v1/ai_settings?select=id", { token: state.a.access });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, []);
});

test("an admin sees only their own cart rows, because cart_items has no admin policy", async () => {
  const r = await rest("GET", "/rest/v1/cart_items?select=user_id", { token: state.admin.access });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, []);
});

test("a student reads their own enrollments and not another student's", async () => {
  const own = await rest("GET", "/rest/v1/enrollments?select=student_id,course_id", { token: state.a.access });
  assert.equal(own.status, 200);
  assert.ok(own.body.length >= 1);
  assert.ok(own.body.every((row) => row.student_id === state.a.id));
  assert.ok(own.body.some((row) => row.course_id === state.c1.id));

  const other = await rest("GET", `/rest/v1/enrollments?select=student_id&student_id=eq.${state.b.id}`, {
    token: state.a.access,
  });
  assert.equal(other.status, 200);
  assert.deepEqual(other.body, []);
});

test("an admin reads all enrollments", async () => {
  const r = await rest("GET", "/rest/v1/enrollments?select=student_id,course_id", { token: state.admin.access });
  assert.equal(r.status, 200);
  const owners = new Set(r.body.map((x) => x.student_id));
  assert.ok(owners.has(state.a.id));
  assert.ok(owners.has(state.b.id));
});

test("the service key reads every row, bypassing row policies", async () => {
  const r = await rest("GET", "/rest/v1/enrollments?select=student_id", { token: SERVICE });
  assert.equal(r.status, 200);
  const owners = new Set(r.body.map((x) => x.student_id));
  assert.ok(owners.has(state.a.id));
  assert.ok(owners.has(state.b.id));
});

test("a student reads questions through the 'Anyone can view questions' policy", async () => {
  const r = await rest("GET", "/rest/v1/questions?select=id&limit=5", { token: state.a.access });
  assert.equal(r.status, 200);
  assert.ok(r.body.length > 0);
  const [{ n }] = await q("SELECT count(*)::int AS n FROM questions");
  assert.ok(n > 0);
});

test("select with an embedded relation resolves through the foreign key", async () => {
  const r = await rest(
    "GET",
    `/rest/v1/cart_items?select=course_id,courses(name)&user_id=eq.${state.a.id}`,
    { token: state.a.access }
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 2);
  for (const row of r.body) assert.equal(typeof row.courses.name, "string");
  assert.ok(r.body.some((row) => row.courses.name === state.c1.name));
});

test("eq, in, or, order and limit filter and sort as PostgREST does", async () => {
  const eq = await rest("GET", `/rest/v1/cart_items?select=course_id&user_id=eq.${state.a.id}`, {
    token: state.a.access,
  });
  assert.equal(eq.body.length, 2);

  const inList = await rest(
    "GET",
    `/rest/v1/cart_items?select=course_id&user_id=eq.${state.a.id}&course_id=in.(${state.c1.id},${state.c2.id})&order=course_id.desc`,
    { token: state.a.access }
  );
  const ids = inList.body.map((x) => x.course_id);
  assert.deepEqual(ids, [...ids].sort().reverse());
  assert.equal(ids.length, 2);

  const limited = await rest(
    "GET",
    `/rest/v1/cart_items?select=course_id&user_id=eq.${state.a.id}&limit=1&order=course_id.asc`,
    { token: state.a.access }
  );
  assert.equal(limited.body.length, 1);

  const orGroup = await rest(
    "GET",
    `/rest/v1/cart_items?select=course_id&or=(course_id.eq.${state.c1.id},course_id.eq.${state.c2.id})&user_id=eq.${state.a.id}`,
    { token: state.a.access }
  );
  assert.equal(orGroup.body.length, 2);

  const ilike = await rest("GET", `/rest/v1/courses?select=id&name=ilike.Rest%20Course%20One%20${tag}*`);
  assert.deepEqual(ilike.body.map((x) => x.id), [state.c1.id]);
});

test("Accept object+json returns one object, and 406 for zero or several rows", async () => {
  const one = await rest(
    "GET",
    `/rest/v1/cart_items?select=course_id&user_id=eq.${state.a.id}&course_id=eq.${state.c1.id}`,
    { token: state.a.access, headers: { Accept: "application/vnd.pgrst.object+json" } }
  );
  assert.equal(one.status, 200);
  assert.equal(one.body.course_id, state.c1.id);

  const none = await rest("GET", `/rest/v1/cart_items?select=id&user_id=eq.${randomUUID()}`, {
    token: state.a.access,
    headers: { Accept: "application/vnd.pgrst.object+json" },
  });
  assert.equal(none.status, 406);
  assert.equal(none.body.code, "PGRST116");

  const many = await rest("GET", `/rest/v1/cart_items?select=id&user_id=eq.${state.a.id}`, {
    token: state.a.access,
    headers: { Accept: "application/vnd.pgrst.object+json" },
  });
  assert.equal(many.status, 406);
});

test("count=exact reports the total in Content-Range, and HEAD returns only that header", async () => {
  const r = await rest("GET", `/rest/v1/cart_items?select=id&user_id=eq.${state.a.id}`, {
    token: state.a.access,
    headers: { Prefer: "count=exact", Range: "0-0" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  assert.match(r.headers.get("content-range"), /^0-0\/2$/);

  const head = await fetch(`${base}/rest/v1/cart_items?select=id&user_id=eq.${state.a.id}`, {
    method: "HEAD",
    headers: { apikey: ANON, Authorization: `Bearer ${state.a.access}` },
  });
  assert.equal(head.status, 200);
  assert.match(head.headers.get("content-range"), /\/2$/);
  assert.equal(await head.text(), "");
});

test("insert on the caller's own row works and inserting for someone else is refused", async () => {
  const ok = await rest("POST", "/rest/v1/cart_items?select=user_id,course_id", {
    token: state.a.access,
    body: { user_id: state.a.id, course_id: state.hidden.id },
    headers: { Prefer: "return=representation" },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body[0].user_id, state.a.id);
  assert.equal(ok.body[0].course_id, state.hidden.id);

  const other = await rest("POST", "/rest/v1/cart_items", {
    token: state.a.access,
    body: { user_id: state.b.id, course_id: state.c1.id },
  });
  assert.equal(other.status, 403);
  assert.equal(other.body.code, "42501");

  const anon = await rest("POST", "/rest/v1/cart_items", {
    body: { user_id: state.a.id, course_id: state.c1.id },
  });
  assert.equal(anon.status, 401);
});

test("a student can update their own profile row", async () => {
  const r = await rest("PATCH", `/rest/v1/profiles?id=eq.${state.a.id}`, {
    token: state.a.access,
    body: { full_name: `Rest Own ${tag}` },
    headers: { Prefer: "return=representation" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body[0].full_name, `Rest Own ${tag}`);
});

test("a student cannot write another user's profile row", async () => {
  const [before] = await q("SELECT full_name FROM profiles WHERE id = $1", [state.b.id]);

  // PATCH matches no rows under the update policy ("Users update own profile"), so it reports 204 and changes nothing.
  const patch = await rest("PATCH", `/rest/v1/profiles?id=eq.${state.b.id}`, {
    token: state.a.access,
    body: { full_name: "Not Allowed" },
  });
  assert.equal(patch.status, 204);

  // Inserting or upserting a row for someone else breaks the insert policy, so it is refused.
  const upsert = await rest("POST", "/rest/v1/profiles?on_conflict=id", {
    token: state.a.access,
    body: { id: state.b.id, full_name: "Hijack" },
    headers: { Prefer: "resolution=merge-duplicates" },
  });
  assert.equal(upsert.status, 403);

  const [after] = await q("SELECT full_name FROM profiles WHERE id = $1", [state.b.id]);
  assert.equal(after.full_name, before.full_name);
  assert.notEqual(after.full_name, "Not Allowed");
  assert.notEqual(after.full_name, "Hijack");
});

test("PATCH and DELETE touch only the rows the policies allow, and writes to public tables need admin", async () => {
  const noFilter = await rest("DELETE", "/rest/v1/cart_items", { token: state.a.access });
  assert.equal(noFilter.status, 400);

  const del = await rest("DELETE", `/rest/v1/cart_items?user_id=eq.${state.a.id}&course_id=eq.${state.hidden.id}`, {
    token: state.a.access,
    headers: { Prefer: "return=representation" },
  });
  assert.equal(del.status, 200);
  assert.equal(del.body.length, 1);

  // Only admins may update courses ("Admins can manage courses"). A student's PATCH matches no rows.
  const [{ description: before }] = await q("SELECT description FROM courses WHERE id = $1", [state.c1.id]);
  const pubWrite = await rest("PATCH", `/rest/v1/courses?id=eq.${state.c1.id}`, {
    token: state.a.access,
    body: { description: "nope" },
    headers: { Prefer: "return=representation" },
  });
  assert.equal(pubWrite.status, 200);
  assert.deepEqual(pubWrite.body, []);
  const [{ description: after }] = await q("SELECT description FROM courses WHERE id = $1", [state.c1.id]);
  assert.equal(after, before);

  const adminWrite = await rest("PATCH", `/rest/v1/courses?id=eq.${state.c1.id}`, {
    token: state.admin.access,
    body: { short_description: `admin ${tag}` },
    headers: { Prefer: "return=representation" },
  });
  assert.equal(adminWrite.status, 200);
  assert.equal(adminWrite.body[0].short_description, `admin ${tag}`);
});

test("rpc calls real functions with named arguments and enforces their access", async () => {
  const pub = await rest("POST", "/rest/v1/rpc/get_category_descendants", {
    body: { parent_uuid: randomUUID() },
  });
  assert.equal(pub.status, 200);
  assert.deepEqual(pub.body, []);

  const enrolled = await rest("POST", "/rest/v1/rpc/check_course_enrollment", {
    token: state.a.access,
    body: { p_course_slug: state.c1.slug },
  });
  assert.equal(enrolled.status, 200);
  assert.equal(enrolled.body, true);

  // get_admin_analytics checks has_role(auth.uid(), 'admin') itself and raises 'forbidden' (P0001, a 400).
  const adminOnly = await rest("POST", "/rest/v1/rpc/get_admin_analytics", {
    token: state.a.access,
    body: { p_since: "2020-01-01T00:00:00Z" },
  });
  assert.equal(adminOnly.status, 400);
  assert.equal(adminOnly.body.message, "forbidden");

  const anonAdmin = await rest("POST", "/rest/v1/rpc/get_admin_analytics", {
    body: { p_since: "2020-01-01T00:00:00Z" },
  });
  assert.equal(anonAdmin.status, 400);
  assert.equal(anonAdmin.body.message, "forbidden");

  // SECURITY DEFINER functions skip RLS, so an identity argument must be the caller's own id (or the caller is admin).
  const otherStudent = await rest("POST", "/rest/v1/rpc/get_enrolled_courses_with_progress", {
    token: state.a.access,
    body: { p_student_id: state.b.id },
  });
  assert.equal(otherStudent.status, 403);

  const ownCourses = await rest("POST", "/rest/v1/rpc/get_enrolled_courses_with_progress", {
    token: state.a.access,
    body: {},
  });
  assert.equal(ownCourses.status, 200);
  assert.ok(Array.isArray(ownCourses.body));
  assert.ok(ownCourses.body.every((row) => row.course_id === state.c1.id));

  const anonCourses = await rest("POST", "/rest/v1/rpc/get_enrolled_courses_with_progress", {
    body: { p_student_id: state.a.id },
  });
  assert.equal(anonCourses.status, 401);

  // Admin-only functions that do not check the caller themselves are gated on the admin role, and worker functions
  // are service-only. Refused calls never reach the function body, so nothing is changed.
  const deleteAsStudent = await rest("POST", "/rest/v1/rpc/delete_subject_cascade", {
    token: state.a.access,
    body: { p_subject_id: randomUUID() },
  });
  assert.equal(deleteAsStudent.status, 403);

  const deleteAsAnon = await rest("POST", "/rest/v1/rpc/delete_subject_cascade", {
    body: { p_subject_id: randomUUID() },
  });
  assert.equal(deleteAsAnon.status, 401);

  const workerAsStudent = await rest("POST", "/rest/v1/rpc/claim_auto_submission_run", {
    token: state.a.access,
    body: { _run_id: randomUUID(), _cooldown_seconds: 60 },
  });
  assert.equal(workerAsStudent.status, 403);

  const workerAsAnon = await rest("POST", "/rest/v1/rpc/claim_notes_auto_pipeline_item", { body: {} });
  assert.equal(workerAsAnon.status, 401);

  const questionBankAsStudent = await rest("POST", "/rest/v1/rpc/get_question_bank_page", {
    token: state.a.access,
    body: { p_limit: 1 },
  });
  assert.equal(questionBankAsStudent.status, 403);

  const questionBankAsAdmin = await rest("POST", "/rest/v1/rpc/get_question_bank_page", {
    token: state.admin.access,
    body: { p_limit: 1 },
  });
  assert.equal(questionBankAsAdmin.status, 200);
  assert.ok(Array.isArray(questionBankAsAdmin.body));

  // The AI teacher search functions exist (see migrations/ai-teacher-search-functions.sql): a call with the wrong
  // arguments is a 400, not a missing function.
  for (const fn of ["search_knowledge_chunks", "search_topic_cards"]) {
    const present = await rest("POST", `/rest/v1/rpc/${fn}`, { body: { seconds: 1 } });
    assert.notEqual(present.status, 404, fn);
  }
  // Functions that do not exist in the database answer PGRST202 (404), as PostgREST does.
  for (const fn of ["pg_sleep"]) {
    const missing = await rest("POST", `/rest/v1/rpc/${fn}`, { body: { seconds: 1 } });
    assert.equal(missing.status, 404, fn);
    assert.equal(missing.body.code, "PGRST202", fn);
  }
});

test("SQL injection attempts on table, column, order and filter names are refused", async () => {
  const dropTable = await rest("GET", "/rest/v1/courses;drop%20table%20courses");
  assert.equal(dropTable.status, 404);

  const dropInSelect = await rest("GET", "/rest/v1/cart_items?select=id;drop%20table%20courses");
  assert.equal(dropInSelect.status, 400);

  const unknownColumn = await rest("GET", "/rest/v1/courses?select=id,name,password_hash");
  assert.equal(unknownColumn.status, 400);
  assert.equal(unknownColumn.body.code, "42703");

  const badOrder = await rest("GET", "/rest/v1/courses?select=id&order=id;drop%20table%20courses");
  assert.equal(badOrder.status, 400);

  const badFilterKey = await rest("GET", "/rest/v1/courses?select=id&id;drop=eq.1");
  assert.equal(badFilterKey.status, 400);

  const badRpc = await rest("POST", "/rest/v1/rpc/get_course_detail;drop%20table%20courses", { body: {} });
  assert.equal(badRpc.status, 404);

  const quoteValue = await rest("GET", "/rest/v1/courses?select=id&name=eq.x'%20OR%20'1'='1");
  assert.equal(quoteValue.status, 200);
  assert.deepEqual(quoteValue.body, []);

  const badUuid = await rest("GET", "/rest/v1/courses?select=id&id=eq.not-a-uuid");
  assert.equal(badUuid.status, 400);

  const [{ n }] = await q("SELECT count(*)::int AS n FROM courses");
  assert.ok(n >= 3, "courses table must still exist with its rows");
});

test("returned ids are UUIDs and the anon read still works after the injection attempts", async () => {
  const r = await rest("GET", `/rest/v1/courses?select=id&id=eq.${state.c2.id}`);
  assert.equal(r.status, 200);
  assert.match(r.body[0].id, UUID_RE);
});
