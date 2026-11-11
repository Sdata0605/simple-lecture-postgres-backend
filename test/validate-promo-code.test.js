import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { q } from "./helpers.js";
import { pool } from "../functions/_shared/db.js";
import { router } from "../functions/validate-promo-code/index.js";

let server;
let base;
const call = async (body) => {
  const r = await fetch(`${base}/functions/v1/validate-promo-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

const tag = `T5${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
let courseId;
const codes = {
  ok: `${tag}OK`,
  inactive: `${tag}IN`,
  course: `${tag}CR`,
};

describe("validate-promo-code", () => {
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/functions/v1/validate-promo-code", router);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
    await q(
      `INSERT INTO public.discount_codes (code, discount_percent, is_active, times_used)
       VALUES ($1, 10, true, 0), ($2, 20, false, 0)`,
      [codes.ok, codes.inactive]
    );
    [{ id: courseId }] = await q("INSERT INTO public.courses (name, slug) VALUES ($1, $2) RETURNING id", [`Course ${tag}`, `c-${tag}`.toLowerCase()]);
    await q(
      `INSERT INTO public.discount_codes (code, discount_percent, is_active, times_used, course_id)
       VALUES ($1, 15, true, 0, $2)`,
      [codes.course, courseId]
    );
  });

  after(async () => {
    await q("DELETE FROM public.discount_codes WHERE code LIKE $1", [`${tag}%`]);
    await q("DELETE FROM public.courses WHERE id = $1", [courseId]);
    await new Promise((r) => server.close(r));
    await pool.end();
  });

  it("rejects a missing code with 400", async () => {
    const r = await call({});
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { valid: false, message: "Promo code is required" });
  });

  it("reports an unknown code as invalid with status 200", async () => {
    const r = await call({ code: `NOPE${tag}` });
    assert.equal(r.status, 200);
    assert.equal(r.body.valid, false);
    assert.equal(r.body.message, "Invalid promo code");
  });

  it("accepts a valid code case-insensitively and returns its discount", async () => {
    const r = await call({ code: codes.ok.toLowerCase() });
    assert.equal(r.status, 200);
    assert.equal(r.body.valid, true);
    assert.equal(r.body.discount_percent, 10);
    assert.equal(r.body.code, codes.ok);
  });

  it("reports an inactive code", async () => {
    const r = await call({ code: codes.inactive });
    assert.equal(r.body.valid, false);
    assert.equal(r.body.message, "This promo code is no longer active");
  });

  it("rejects a course-restricted code used on another course", async () => {
    const r = await call({ code: codes.course, course_id: "00000000-0000-4000-8000-000000000002" });
    assert.equal(r.body.valid, false);
    assert.equal(r.body.message, "This promo code is not valid for this course");
  });
});
