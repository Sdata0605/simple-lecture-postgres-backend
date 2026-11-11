import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { q } from "./helpers.js";
import { router } from "../functions/ai-generate-mcqs/index.js";
import { mountRouter, closeDb } from "./_group00-harness.js";

let app;
const ask = (body) => app.post("/", body);
const realFetch = globalThis.fetch;
const marker = `mcq-test-${crypto.randomUUID()}`;
let topicId;
let courseId;
let savedConfig;
let hadConfig;

function stubAi(content, status = 200) {
  globalThis.fetch = (url, opts) => {
    if (String(url).startsWith("https://api.openai.com/")) {
      return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status }));
    }
    return realFetch(url, opts);
  };
}
async function setConfig(value) {
  const updated = await q("UPDATE public.ai_settings SET setting_value = $1 WHERE setting_key = 'ai_api_config' RETURNING id", [value]);
  if (updated.length === 0) await q("INSERT INTO public.ai_settings (setting_key, setting_value) VALUES ('ai_api_config', $1)", [value]);
}

describe("ai-generate-mcqs", () => {
  before(async () => {
    app = await mountRouter("/", router);
    const [course] = await q(
      "INSERT INTO public.courses (name, slug, free_preview_ai_limit, free_preview_doubts_limit) VALUES ('MCQ Test', $1, 0, 0) RETURNING id",
      [marker]
    );
    courseId = course.id;
    const [chapter] = await q(
      "INSERT INTO public.chapters (course_id, subject, chapter_number, title, description) VALUES ($1, 'Test', 1, 'Motion', 'About motion') RETURNING id",
      [courseId]
    );
    const [topic] = await q(
      "INSERT INTO public.topics (chapter_id, topic_number, title, content_markdown) VALUES ($1, 1, 'Velocity', 'Velocity is displacement per time.') RETURNING id",
      [chapter.id]
    );
    topicId = topic.id;
    const rows = await q("SELECT setting_value FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    hadConfig = rows.length > 0;
    savedConfig = hadConfig ? rows[0].setting_value : null;
  });
  after(async () => {
    globalThis.fetch = realFetch;
    await q("DELETE FROM public.questions WHERE topic_id = $1", [topicId]);
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

  it("requires topic_id", async () => {
    const r = await ask({ difficulty: "easy" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "topic_id is required");
  });

  it("an unknown topic is a 500 'Topic not found'", async () => {
    const r = await ask({ topic_id: crypto.randomUUID() });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "Topic not found");
  });

  it("returns 503 when no AI provider is configured", async () => {
    await setConfig({ enabled: false });
    const r = await ask({ topic_id: topicId });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /AI API not configured/);
  });

  // Note: the success path (insert into questions) is not tested here. questions.topic_id references
  // subject_topics, while this function reads public.topics, so a real save needs that schema link.
  it("unparseable AI output is a 500 and saves nothing", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    stubAi("not json at all");
    const before = await q("SELECT count(*)::int AS n FROM public.questions WHERE topic_id = $1", [topicId]);
    const r = await ask({ topic_id: topicId });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "Failed to parse MCQ data from AI response");
    const after = await q("SELECT count(*)::int AS n FROM public.questions WHERE topic_id = $1", [topicId]);
    assert.equal(after[0].n, before[0].n);
    globalThis.fetch = realFetch;
  });
});
