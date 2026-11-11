import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { q } from "./helpers.js";
import { router } from "../functions/ai-generate-assignment/index.js";
import { mountRouter, closeDb } from "./_group00-harness.js";

let app;
const ask = (body) => app.post("/", body);
const realFetch = globalThis.fetch;
let savedConfig;
let hadConfig;
const config = { difficultyMix: { easy: 40, medium: 40, hard: 20 }, questionTypes: ["mcq", "short_answer"], totalMarks: 10, durationMinutes: 20 };
const args = () => ({ subjectId: crypto.randomUUID(), chapterId: crypto.randomUUID(), config });

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

describe("ai-generate-assignment", () => {
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

  it("requires subject and chapter ids", async () => {
    const r = await ask({ subjectId: crypto.randomUUID(), config });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "Subject ID and Chapter ID are required");
  });

  it("returns 503 when no AI provider is configured", async () => {
    await setConfig({ enabled: false });
    assert.equal((await ask(args())).status, 503);
  });

  it("returns the drafted questions with totals (stubbed provider)", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    const questions = [
      { question: "Q1", type: "mcq", marks: 4 },
      { question: "Q2", type: "short_answer", marks: 6 },
    ];
    stubAi(200, "Here you go:\n" + JSON.stringify(questions));
    const r = await ask(args());
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.totalQuestions, 2);
    assert.equal(r.body.totalMarks, 10);
    assert.equal(r.body.title, "Chapter Assignment");
    globalThis.fetch = realFetch;
  });

  it("maps a 429 from the provider to a friendly message", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    stubAi(429, "slow");
    const r = await ask(args());
    assert.equal(r.status, 429);
    assert.match(r.body.error, /Rate limit exceeded/);
    globalThis.fetch = realFetch;
  });

  it("a reply without a JSON array is a 500", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    stubAi(200, "sorry, no list");
    const r = await ask(args());
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "Failed to parse AI-generated questions");
    globalThis.fetch = realFetch;
  });
});
