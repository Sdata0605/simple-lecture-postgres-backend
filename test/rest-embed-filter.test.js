import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { startServer, stopServer, base, q } from "./helpers.js";

// Category used by the CBSE page in the restored data (see public.categories, slug 'cbse').
const CBSE = "c642a3e7-d4d2-41b8-a458-3da47d75f457";
const OTHER = "8dd21ce7-d087-49a6-9881-867d87448ec2";
const ANON = { apikey: "anon-placeholder" };

const get = (path) => fetch(base + path, { headers: ANON }).then(async (r) => ({ status: r.status, body: await r.json() }));

let courseId;
let linkId;

describe("rest: filters on embedded resources", () => {
  before(async () => {
    await startServer();
    courseId = (
      await q(
        "INSERT INTO public.courses (name, slug, price_inr, is_active) VALUES ($1, $2, 0, true) RETURNING id",
        ["Embed filter test", "embed-filter-" + crypto.randomBytes(4).toString("hex")]
      )
    )[0].id;
    linkId = (
      await q("INSERT INTO public.course_categories (course_id, category_id) VALUES ($1, $2) RETURNING id", [courseId, CBSE])
    )[0].id;
  });
  after(async () => {
    await q("DELETE FROM public.course_categories WHERE id = $1", [linkId]);
    await q("DELETE FROM public.courses WHERE id = $1", [courseId]);
    await stopServer();
  });

  it("!inner embed filter keeps only parent rows that have a matching embedded row", async () => {
    const r = await get(`/rest/v1/courses?select=id,course_categories!inner(category_id)&course_categories.category_id=in.(${CBSE},${OTHER})&is_active=eq.true`);
    assert.equal(r.status, 200);
    assert.ok(r.body.some((c) => c.id === courseId), "the CBSE test course is returned");
    for (const c of r.body) {
      assert.ok(c.course_categories.length >= 1);
      assert.ok(c.course_categories.every((x) => [CBSE, OTHER].includes(x.category_id)));
    }
  });

  it("!inner embed filter excludes parent rows with no matching embedded row", async () => {
    const r = await get(`/rest/v1/courses?select=id,course_categories!inner(category_id)&course_categories.category_id=eq.${OTHER}`);
    assert.equal(r.status, 200);
    assert.ok(!r.body.some((c) => c.id === courseId), "a course linked only to CBSE is not returned for OTHER");
  });

  it("plain embed filter filters the embedded rows but keeps every parent row", async () => {
    const r = await get(`/rest/v1/courses?select=id,course_categories(category_id)&course_categories.category_id=eq.${CBSE}&id=eq.${courseId}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 1);
    assert.deepEqual(r.body[0].course_categories.map((x) => x.category_id), [CBSE]);
    const none = await get(`/rest/v1/courses?select=id,course_categories(category_id)&course_categories.category_id=eq.${OTHER}&id=eq.${courseId}`);
    assert.equal(none.status, 200);
    assert.equal(none.body.length, 1, "parent kept even though no embedded row matches");
    assert.deepEqual(none.body[0].course_categories, []);
  });

  it("count query honours a !inner embed filter", async () => {
    const r = await fetch(`${base}/rest/v1/courses?select=id,course_categories!inner(category_id)&course_categories.category_id=eq.${CBSE}&id=eq.${courseId}`, {
      headers: { ...ANON, Prefer: "count=exact" },
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-range").split("/")[1], "1");
  });

  it("an embed filter for a relation not in select is refused", async () => {
    const r = await get(`/rest/v1/courses?select=id&course_categories.category_id=eq.${CBSE}`);
    assert.equal(r.status, 400);
    assert.match(r.body.message, /must be in select/);
  });

  it("RPC with RETURNS TABLE(one column) returns objects, as PostgREST does", async () => {
    const r = await fetch(base + "/rest/v1/rpc/get_category_descendants", {
      method: "POST",
      headers: { ...ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ parent_uuid: CBSE }),
    });
    assert.equal(r.status, 200);
    const rows = await r.json();
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((x) => typeof x.category_id === "string"));
    assert.ok(rows.some((x) => x.category_id === CBSE));
  });

  it("embed hints may name the foreign-key constraint (as the UI does)", async () => {
    const r = await get("/rest/v1/teacher_profiles?select=id,department:departments!teacher_profiles_department_id_fkey(id,name)&limit=2");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = await get("/rest/v1/departments?select=id,head:teacher_profiles!departments_head_of_department_fkey(id,full_name)&limit=2");
    assert.equal(d.status, 200, JSON.stringify(d.body));
  });
});
