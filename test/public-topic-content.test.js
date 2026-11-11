import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { startServer, stopServer, q } from "./helpers.js";
import { router } from "../functions/public-topic-content/index.js";

// Read-only test: it looks up a topic that already exists in the test database and writes nothing.
let fnServer;
let fnBase;
let ref; // { name, slug, chapter_number, topic_number }

async function get(qs) {
  const res = await fetch(`${fnBase}/${qs}`);
  return { status: res.status, body: await res.json() };
}
async function post(body) {
  const res = await fetch(`${fnBase}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe("public-topic-content", () => {
  before(async () => {
    await startServer();
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/", router);
    fnServer = app.listen(0, "127.0.0.1");
    await once(fnServer, "listening");
    fnBase = `http://127.0.0.1:${fnServer.address().port}`;
    [ref] = await q(
      `SELECT s.name, s.slug, c.chapter_number, t.topic_number
         FROM public.subject_topics t
         JOIN public.subject_chapters c ON c.id = t.chapter_id
         JOIN public.popular_subjects s ON s.id = c.subject_id
        ORDER BY s.name, c.chapter_number, t.topic_number LIMIT 1`
    );
  });

  after(async () => {
    await new Promise((r) => fnServer.close(r));
    await stopServer();
  });

  it("answers OPTIONS", async () => {
    const r = await fetch(`${fnBase}/`, { method: "OPTIONS" });
    assert.equal(r.status, 200);
  });

  it("400 when subject, chapter or topic is missing or not a number", async () => {
    assert.equal((await get("")).status, 400);
    assert.equal((await get("?subject=Maths&chapter=abc&topic=1")).status, 400);
    assert.equal((await get("?subject=Maths&chapter=1")).body.code, "bad_request");
  });

  it("400 for over-long input", async () => {
    const long = "x".repeat(201);
    const r = await get(`?subject=${long}&chapter=1&topic=1`);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "Input too long");
  });

  it("404 subject_not_found for an unknown subject", async () => {
    const r = await get("?subject=No%20Such%20Subject%20zz&chapter=1&topic=1");
    assert.equal(r.status, 404);
    assert.equal(r.body.code, "subject_not_found");
  });

  it("404 chapter_not_found for a chapter number that does not exist", async () => {
    const r = await get(`?subject=${encodeURIComponent(ref.name)}&chapter=99999&topic=1`);
    assert.equal(r.status, 404);
    assert.equal(r.body.code, "chapter_not_found");
  });

  it("404 topic_not_found for a topic number that does not exist", async () => {
    const r = await get(`?subject=${encodeURIComponent(ref.name)}&chapter=${ref.chapter_number}&topic=no-such-topic`);
    assert.equal(r.status, 404);
    assert.equal(r.body.code, "topic_not_found");
  });

  it("returns the topic with its questions (GET query string)", async () => {
    const r = await get(`?subject=${encodeURIComponent(ref.name)}&chapter=${ref.chapter_number}&topic=${encodeURIComponent(ref.topic_number)}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.subject.name, ref.name);
    assert.equal(r.body.chapter.chapter_number, ref.chapter_number);
    assert.equal(r.body.topic.topic_number, ref.topic_number);
    assert.ok(Array.isArray(r.body.questions));
    assert.equal(r.body.counts.questions, r.body.questions.length);
    assert.ok(r.body.document === null || typeof r.body.document.id === "string");
  });

  it("accepts the subject by slug and the inputs from a JSON body (POST)", async () => {
    const r = await post({ subject: ref.slug, chapter: String(ref.chapter_number), topic: ref.topic_number });
    assert.equal(r.status, 200);
    assert.equal(r.body.subject.slug, ref.slug);
  });

  it("matches the subject name literally: LIKE wildcards are not honoured", async () => {
    const r = await get("?subject=%25&chapter=1&topic=1");
    assert.equal(r.status, 404);
    assert.equal(r.body.code, "subject_not_found");
  });
});
