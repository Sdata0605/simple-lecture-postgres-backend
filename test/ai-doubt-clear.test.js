import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { q } from "./helpers.js";
import { router } from "../functions/ai-doubt-clear/index.js";
import { mountRouter, closeDb } from "./_group00-harness.js";

let app;
const ask = (body) => app.post("/", body);
const realFetch = globalThis.fetch;
const marker = `doubt-test-${crypto.randomUUID()}`;
let topicId = null;
let courseId = null;
let savedConfig;
let hadConfig;
const studentId = crypto.randomUUID();

const reply = (obj) => new Response(JSON.stringify(obj), { status: 200 });
// Stubs the external provider; each call receives the next canned reply.
function stubAi(replies) {
  const calls = [];
  globalThis.fetch = (url, opts) => {
    if (String(url).startsWith("https://api.openai.com/")) {
      calls.push(JSON.parse(opts.body));
      return Promise.resolve(replies.shift());
    }
    return realFetch(url, opts);
  };
  return calls;
}
async function setConfig(value) {
  const updated = await q("UPDATE public.ai_settings SET setting_value = $1 WHERE setting_key = 'ai_api_config' RETURNING id", [value]);
  if (updated.length === 0) await q("INSERT INTO public.ai_settings (setting_key, setting_value) VALUES ('ai_api_config', $1)", [value]);
}

describe("ai-doubt-clear", () => {
  before(async () => {
    app = await mountRouter("/", router);
    // Fixture: a course -> chapter -> topic chain, removed in after().
    const [course] = await q(
      "INSERT INTO public.courses (name, slug, free_preview_ai_limit, free_preview_doubts_limit) VALUES ('Doubt Test', $1, 0, 0) RETURNING id",
      [marker]
    );
    courseId = course.id;
    const [chapter] = await q(
      "INSERT INTO public.chapters (course_id, subject, chapter_number, title, description) VALUES ($1, 'Test', 1, 'Light', 'Chapter on light') RETURNING id",
      [courseId]
    );
    const [topic] = await q(
      "INSERT INTO public.topics (chapter_id, topic_number, title, content_markdown) VALUES ($1, 1, 'Reflection', 'Light reflects off mirrors.') RETURNING id",
      [chapter.id]
    );
    topicId = topic.id;
    const rows = await q("SELECT setting_value FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    hadConfig = rows.length > 0;
    savedConfig = hadConfig ? rows[0].setting_value : null;
  });
  after(async () => {
    globalThis.fetch = realFetch;
    await q("DELETE FROM public.doubt_logs WHERE question LIKE $1", [`%${marker}%`]);
    await q("DELETE FROM public.topics WHERE id = $1", [topicId]);
    await q("DELETE FROM public.chapters WHERE course_id = $1", [courseId]);
    await q("DELETE FROM public.courses WHERE id = $1", [courseId]);
    if (hadConfig) {
      await q("UPDATE public.ai_settings SET setting_value = $1 WHERE setting_key = 'ai_api_config'", [savedConfig]);
    } else {
      await q("DELETE FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    }
    await app.close();
    await closeDb();
  });

  it("requires question, topic_id and student_id", async () => {
    const r = await ask({ question: "What is light?" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "Missing required fields");
  });

  it("an unknown topic is a 500 'Topic not found'", async () => {
    const r = await ask({ question: "What is light?", topic_id: crypto.randomUUID(), student_id: studentId });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "Topic not found");
  });

  it("greetings are refused without calling the model", async () => {
    const calls = stubAi([]);
    const r = await ask({ question: "hi", topic_id: topicId, student_id: studentId });
    assert.equal(r.status, 200);
    assert.equal(r.body.out_of_syllabus, true);
    assert.equal(calls.length, 0);
  });

  it("returns 503 when no AI provider is configured", async () => {
    await setConfig({ enabled: false });
    const r = await ask({ question: "Explain this topic in detail please", topic_id: topicId, student_id: studentId });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /AI API not configured/);
  });

  it("off-topic classification refuses and logs the refusal", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    const calls = stubAi([reply({ choices: [{ message: { content: '{"relevant": false, "confidence": 0.9}' } }] })]);
    const question = `Who won the cricket match? ${marker}`;
    const r = await ask({ question, topic_id: topicId, student_id: studentId });
    assert.equal(r.status, 200);
    assert.equal(r.body.out_of_syllabus, true);
    assert.equal(calls.length, 1);
    globalThis.fetch = realFetch;
  });

  it("relevant question is answered from the stubbed model", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    stubAi([
      reply({ choices: [{ message: { content: '{"relevant": true, "confidence": 0.95}' } }] }),
      reply({ choices: [{ message: { content: "Stubbed tutor answer." } }] }),
    ]);
    const r = await ask({ question: `Please explain the main idea ${marker}`, topic_id: topicId, student_id: studentId });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { answer: "Stubbed tutor answer." });
    globalThis.fetch = realFetch;
  });
});
