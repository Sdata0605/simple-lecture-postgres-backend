import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { serveRouter, hitAt } from "./route-harness.js";
import { router, hooks, mapQuestion } from "../functions/extract-json-to-questions/index.js";

describe("extract-json-to-questions", () => {
  let r;
  let user;
  let savedRow;
  const savedSvc = process.env.SERVICE_KEY;
  const realFetch = hooks.fetch;
  before(async () => {
    await startServer();
    r = await serveRouter("/functions/v1/extract-json-to-questions", router);
    user = await makeUser();
    process.env.SERVICE_KEY = "test-service-key-not-real";
    const rows = await q("SELECT setting_value FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    savedRow = rows.length ? rows[0].setting_value : undefined;
  });
  after(async () => {
    hooks.fetch = realFetch;
    await q("DELETE FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    if (savedRow !== undefined) {
      await q("INSERT INTO public.ai_settings (setting_key, setting_value) VALUES ('ai_api_config', $1)", [JSON.stringify(savedRow)]);
    }
    if (savedSvc === undefined) delete process.env.SERVICE_KEY;
    else process.env.SERVICE_KEY = savedSvc;
    await r.close();
    await stopServer();
  });

  const body = { contentJson: "Q1. What is 2+2?", subjectId: "s", chapterId: "c" };

  it("requires a user token or the service key", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/extract-json-to-questions", { body });
    assert.equal(res.status, 401);
  });

  it("rejects missing required fields", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/extract-json-to-questions", {
      body: { contentJson: "x" },
      headers: { Authorization: `Bearer ${user.access}` },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Missing required fields/);
  });

  it("maps model output to the question shape", () => {
    const row = mapQuestion(
      { question_type: "MCQ", options: [" 4", "5"], difficulty: "hard", question_text: "2+2?", correct_answer: "4" },
      { topicId: "t", subtopicId: null, chapterId: "c" },
    );
    assert.equal(row.question_type, "mcq");
    assert.equal(row.difficulty, "Advanced");
    assert.deepEqual(row.options, { A: { text: " 4" }, B: { text: "5" } });
    assert.equal(row.chapter_id, "c");
    const sub = mapQuestion({ question_type: "short_answer", question_text: "Why $x$?" }, {});
    assert.equal(sub.question_type, "subjective");
    assert.equal(sub.contains_formula, true);
    assert.equal(sub.marks, 4);
  });

  it("returns 200 with a parse error for a non-JSON model reply (stubbed)", async () => {
    await q("DELETE FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    await q("INSERT INTO public.ai_settings (setting_key, setting_value) VALUES ('ai_api_config', $1)", [
      JSON.stringify({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" }),
    ]);
    hooks.fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "not json at all" } }] }), { status: 200 });
    const res = await hitAt(r.base, "POST", "/functions/v1/extract-json-to-questions", {
      body,
      headers: { "x-service-key": process.env.SERVICE_KEY },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.questionsCount, 0);
    assert.equal(res.body.error, "Failed to parse extracted questions");
  });
});
