import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { serveRouter, hitAt } from "./route-harness.js";
import {
  router,
  hooks,
  preScanDocument,
  chunkDocument,
  normalizeQuestions,
  parseAIResponse,
  mergeChunkResults,
} from "../functions/extract-pyq-questions/index.js";

describe("extract-pyq-questions", () => {
  let r;
  let user;
  let savedRow;
  const realFetch = hooks.fetch;
  const realSleep = hooks.sleep;
  before(async () => {
    await startServer();
    r = await serveRouter("/functions/v1/extract-pyq-questions", router);
    user = await makeUser();
    const rows = await q("SELECT setting_value FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    savedRow = rows.length ? rows[0].setting_value : undefined;
  });
  after(async () => {
    hooks.fetch = realFetch;
    hooks.sleep = realSleep;
    await q("DELETE FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    if (savedRow !== undefined) {
      await q("INSERT INTO public.ai_settings (setting_key, setting_value) VALUES ('ai_api_config', $1)", [JSON.stringify(savedRow)]);
    }
    await r.close();
    await stopServer();
  });

  it("requires a service key or user token", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/extract-pyq-questions", { body: { contentMarkdown: "x".repeat(200) } });
    assert.equal(res.status, 401);
  });

  it("reports NO_CONTENT for a short document", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/extract-pyq-questions", {
      body: { contentMarkdown: "too short" },
      headers: { Authorization: `Bearer ${user.access}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.errorCode, "NO_CONTENT");
  });

  it("reports AI_NOT_CONFIGURED when no provider is enabled", async () => {
    await q("DELETE FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    await q("INSERT INTO public.ai_settings (setting_key, setting_value) VALUES ('ai_api_config', $1)", [
      JSON.stringify({ enabled: false }),
    ]);
    const res = await hitAt(r.base, "POST", "/functions/v1/extract-pyq-questions", {
      body: { contentMarkdown: "Q1. What is a cell? ".repeat(20) },
      headers: { Authorization: `Bearer ${user.access}` },
    });
    assert.equal(res.body.errorCode, "AI_NOT_CONFIGURED");
  });

  it("extracts and renumbers questions from a stubbed tool-call reply", async () => {
    await q("DELETE FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    await q("INSERT INTO public.ai_settings (setting_key, setting_value) VALUES ('ai_api_config', $1)", [
      JSON.stringify({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" }),
    ]);
    hooks.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      arguments: JSON.stringify({
                        questions: [
                          { question_number: 1, question_text: "Which is a mammal?", question_format: "mcq", options: { a: "Bat", b: "Frog" } },
                          { question_number: 2, question_text: "Explain photosynthesis briefly.", question_format: "subjective" },
                        ],
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    const res = await hitAt(r.base, "POST", "/functions/v1/extract-pyq-questions", {
      body: { contentMarkdown: "Q1. Which is a mammal? Bat or Frog. ".repeat(10) },
      headers: { Authorization: `Bearer ${user.access}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.questionsCount, 2);
    assert.deepEqual(res.body.questions[0].options, { A: { text: "Bat" }, B: { text: "Frog" } });
    assert.equal(res.body.questions[1].question_format, "subjective");
  });

  it("pre-scans numbered questions and chunks long text", () => {
    const text = Array.from({ length: 6 }, (_, i) => `${i + 1}. Question body ${i + 1} here`).join("\n");
    const scan = preScanDocument(text);
    assert.equal(scan.estimatedCount, 6);
    assert.equal(chunkDocument("short").length, 1);
    assert.ok(chunkDocument("line\n".repeat(60000)).length > 1);
  });

  it("normalises, de-duplicates and merges", () => {
    const n = normalizeQuestions([
      { question_number: 2, question_text: "Two?", question_format: "true_false" },
      { question_number: 1, question_text: "One is fine", difficulty: "hard" },
      { question_number: 1, question_text: "Duplicate number" },
      { question_number: 3, question_text: "x" },
    ]);
    assert.deepEqual(n.map((x) => x.question_number), [1, 2]);
    assert.equal(n[0].difficulty, "Advanced");
    const merged = mergeChunkResults([[n[0]], [{ ...n[0], question_number: 9 }, n[1]]]);
    assert.deepEqual(merged.map((x) => x.question_number), [1, 2]);
    assert.equal(parseAIResponse({ content: "[{\"question_text\":\"Hi there\"}]" })[0].question_text, "Hi there");
  });
});
