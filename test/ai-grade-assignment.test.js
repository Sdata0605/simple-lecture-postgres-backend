import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { q } from "./helpers.js";
import { router } from "../functions/ai-grade-assignment/index.js";
import { mountRouter, closeDb } from "./_group00-harness.js";

let app;
const ask = (body) => app.post("/", body);
const realFetch = globalThis.fetch;
let savedConfig;
let hadConfig;
const questions = [
  { question_id: "q1", question: "Capital of France?", type: "short_answer", correct_answer: "Paris", student_answer: "Paris", marks: 2 },
  { question_id: "q2", question: "2+2?", type: "mcq", correct_answer: "4", student_answer: "", marks: 1 },
];

function stubAi(status, content) {
  globalThis.fetch = (url, opts) => {
    if (String(url).startsWith("https://api.openai.com/")) {
      const text = status === 200 ? JSON.stringify({ choices: [{ message: { content } }] }) : content;
      return Promise.resolve(new Response(text, { status }));
    }
    return realFetch(url, opts);
  };
}
async function setConfig(value) {
  const updated = await q("UPDATE public.ai_settings SET setting_value = $1 WHERE setting_key = 'ai_api_config' RETURNING id", [value]);
  if (updated.length === 0) await q("INSERT INTO public.ai_settings (setting_key, setting_value) VALUES ('ai_api_config', $1)", [value]);
}

describe("ai-grade-assignment", () => {
  before(async () => {
    app = await mountRouter("/", router);
    const rows = await q("SELECT setting_value FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    hadConfig = rows.length > 0;
    savedConfig = hadConfig ? rows[0].setting_value : null;
  });
  after(async () => {
    globalThis.fetch = realFetch;
    if (hadConfig) {
      await q("UPDATE public.ai_settings SET setting_value = $1 WHERE setting_key = 'ai_api_config'", [savedConfig]);
    } else {
      await q("DELETE FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    }
    await app.close();
    await closeDb();
  });

  it("requires a non-empty questions array", async () => {
    const r = await ask({ questions: [] });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "No questions provided for grading");
  });

  it("returns 503 when no AI provider is configured", async () => {
    await setConfig({ enabled: false });
    assert.equal((await ask({ questions })).status, 503);
  });

  it("grades, clamps marks to the maximum, and totals (stubbed provider)", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    stubAi(200, JSON.stringify([
      { question_id: "q1", marks_awarded: 9, feedback: "Good", is_correct: true },
      { question_id: "q2", marks_awarded: 0, feedback: "Blank", is_correct: false },
    ]));
    const r = await ask({ questions });
    assert.equal(r.status, 200);
    assert.equal(r.body.total_max_marks, 3);
    assert.equal(r.body.total_marks_awarded, 2);
    assert.equal(r.body.percentage, 67);
    assert.equal(r.body.grades[0].marks_awarded, 2);
    globalThis.fetch = realFetch;
  });

  it("an unparseable reply marks every question for manual review", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    stubAi(200, "no json here");
    const r = await ask({ questions });
    assert.equal(r.status, 200);
    assert.equal(r.body.total_marks_awarded, 0);
    assert.equal(r.body.grades[0].feedback, "Unable to grade automatically. Please review manually.");
    globalThis.fetch = realFetch;
  });
});
