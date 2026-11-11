import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { startServer, stopServer, base, q, makeUser } from "./helpers.js";

// Regression: supabase-js .insert().select().single() sends Accept: application/vnd.pgrst.object+json.
// The write routes used to return an array, so the app got no id and the "New Practice" assignment never opened.
const SUBJECT = "ceaf73fb-528a-4d4a-947c-4a7be304db2b";

describe("rest: single-object responses for writes", () => {
  let user;
  const created = [];
  before(async () => {
    await startServer();
    user = await makeUser();
  });
  after(async () => {
    if (created.length) await q("DELETE FROM public.assignments WHERE id = ANY($1::uuid[])", [created]);
    await stopServer();
  });

  const headers = (single) => ({
    apikey: "anon-placeholder",
    Authorization: `Bearer ${user.access}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
    ...(single ? { Accept: "application/vnd.pgrst.object+json" } : {}),
  });
  const row = () => ({
    title: "REST single test " + crypto.randomBytes(3).toString("hex"),
    subject_id: SUBJECT,
    questions: [{ id: "q1", type: "mcq", marks: 1, options: ["a", "b"], question: "x?", correct_answer: "a" }],
    total_marks: 1,
    passing_marks: 0,
    is_active: true,
    source_type: "self_practice",
  });

  it("insert with a single-object Accept returns the one created row, with an id", async () => {
    const r = await fetch(`${base}/rest/v1/assignments?select=*`, { method: "POST", headers: headers(true), body: JSON.stringify(row()) });
    const j = await r.json();
    assert.equal(r.status, 201, JSON.stringify(j));
    assert.equal(Array.isArray(j), false, "a single object, not an array");
    assert.equal(typeof j.id, "string");
    created.push(j.id);
  });

  it("insert without the single-object Accept still returns an array", async () => {
    const r = await fetch(`${base}/rest/v1/assignments?select=*`, { method: "POST", headers: headers(false), body: JSON.stringify(row()) });
    const j = await r.json();
    assert.equal(r.status, 201, JSON.stringify(j));
    assert.ok(Array.isArray(j));
    assert.equal(j.length, 1);
    created.push(j[0].id);
  });

  it("PATCH with a single-object Accept returns one object", async () => {
    const id = created[0];
    const r = await fetch(`${base}/rest/v1/assignments?id=eq.${id}&select=id,title`, {
      method: "PATCH",
      headers: headers(true),
      body: JSON.stringify({ title: "REST single patched" }),
    });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.id, id);
    assert.equal(j.title, "REST single patched");
  });

  it("a single-object write that matches several rows is refused with 406, as GET does", async () => {
    const r = await fetch(`${base}/rest/v1/assignments?subject_id=eq.${SUBJECT}&source_type=eq.self_practice_never_matches_xyz&select=id`, {
      method: "PATCH",
      headers: headers(true),
      body: JSON.stringify({ title: "nothing" }),
    });
    assert.equal(r.status, 406);
  });
});
