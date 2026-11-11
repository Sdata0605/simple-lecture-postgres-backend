import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser } from "./helpers.js";
import { serveRouter, hitAt } from "./route-harness.js";
import { router, hooks, parseBody, buildInsert } from "../functions/generate-topic-notes-questions/index.js";

const TOPIC = "00000000-0000-4000-8000-000000000001";

describe("generate-topic-notes-questions", () => {
  let r;
  let user;
  const savedKey = process.env.LOVABLE_API_KEY;
  const realFetch = hooks.fetch;
  before(async () => {
    await startServer();
    r = await serveRouter("/functions/v1/generate-topic-notes-questions", router);
    user = await makeUser();
  });
  after(async () => {
    hooks.fetch = realFetch;
    if (savedKey === undefined) delete process.env.LOVABLE_API_KEY;
    else process.env.LOVABLE_API_KEY = savedKey;
    await r.close();
    await stopServer();
  });
  const auth = () => ({ Authorization: `Bearer ${user.access}` });
  const body = { topic_id: TOPIC, section_id: "s1", section_title: "Cells", count: 3 };

  it("validates the body and applies defaults", () => {
    assert.ok(parseBody({ topic_id: "bad" }).fieldErrors.topic_id);
    const ok = parseBody(body);
    assert.equal(ok.data.count, 3);
    assert.equal(ok.data.chapter_id, null);
    assert.deepEqual(ok.data.key_points, []);
    assert.ok(parseBody({ ...body, count: 11 }).fieldErrors.count);
  });

  it("builds a parameterised multi-row insert", () => {
    const ins = buildInsert("questions", ["a", "b"], [{ a: 1, b: null }, { a: 2, b: "x" }]);
    assert.equal(ins.text, "INSERT INTO public.questions (a, b) VALUES ($1, $2), ($3, $4) RETURNING id");
    assert.deepEqual(ins.params, [1, null, 2, "x"]);
  });

  it("returns 500 when LOVABLE_API_KEY is missing", async () => {
    delete process.env.LOVABLE_API_KEY;
    const res = await hitAt(r.base, "POST", "/functions/v1/generate-topic-notes-questions", { body, headers: auth() });
    assert.equal(res.status, 500);
    assert.equal(res.body.error, "Missing LOVABLE_API_KEY");
  });

  it("requires a Bearer token", async () => {
    process.env.LOVABLE_API_KEY = "test-key-not-real";
    const res = await hitAt(r.base, "POST", "/functions/v1/generate-topic-notes-questions", { body });
    assert.equal(res.status, 401);
  });

  it("returns 400 with field errors for an invalid body", async () => {
    process.env.LOVABLE_API_KEY = "test-key-not-real";
    const res = await hitAt(r.base, "POST", "/functions/v1/generate-topic-notes-questions", {
      body: { ...body, topic_id: "nope" },
      headers: auth(),
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.topic_id);
  });

  it("reports zero inserts when the AI returns no questions (stubbed)", async () => {
    process.env.LOVABLE_API_KEY = "test-key-not-real";
    hooks.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "{\"questions\":[]}" } }] }), { status: 200 });
    const res = await hitAt(r.base, "POST", "/functions/v1/generate-topic-notes-questions", { body, headers: auth() });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { inserted: 0, message: "No questions generated" });
  });

  it("returns the gateway status when the AI call fails (stubbed)", async () => {
    process.env.LOVABLE_API_KEY = "test-key-not-real";
    hooks.fetch = async () => new Response("rate", { status: 429 });
    const res = await hitAt(r.base, "POST", "/functions/v1/generate-topic-notes-questions", { body, headers: auth() });
    assert.equal(res.status, 429);
    assert.equal(res.body.error, "AI gateway failed");
  });
});
