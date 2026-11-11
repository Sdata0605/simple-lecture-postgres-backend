import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { q } from "./helpers.js";
import { router } from "../functions/ai-suggest-chapter-topic/index.js";
import { mountRouter, closeDb } from "./_group00-harness.js";

let app;
const ask = (body) => app.post("/", body);
const realFetch = globalThis.fetch;
let savedConfig;
let hadConfig;

function stubAi(status, content) {
  globalThis.fetch = (url, opts) => {
    if (String(url).startsWith("https://api.openai.com/")) {
      const body = status === 200 ? JSON.stringify({ choices: [{ message: { content } }] }) : content;
      return Promise.resolve(new Response(body, { status }));
    }
    return realFetch(url, opts);
  };
}
async function setConfig(value) {
  const updated = await q("UPDATE public.ai_settings SET setting_value = $1 WHERE setting_key = 'ai_api_config' RETURNING id", [value]);
  if (updated.length === 0) await q("INSERT INTO public.ai_settings (setting_key, setting_value) VALUES ('ai_api_config', $1)", [value]);
}

describe("ai-suggest-chapter-topic", () => {
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

  it("requires questionText and subjectId", async () => {
    const r = await ask({ questionText: "What is inertia?" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "questionText and subjectId are required");
  });

  it("returns 503 when no AI provider is configured", async () => {
    await setConfig({ enabled: false });
    const r = await ask({ questionText: "What is inertia?", subjectId: "s1" });
    assert.equal(r.status, 503);
  });

  it("returns the parsed suggestion object from a fenced reply (stubbed provider)", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    const suggestion = {
      suggestedChapter: { id: null, title: "Motion", confidence: 0.9, reasoning: "about motion" },
      suggestedTopic: { id: null, title: "Inertia", confidence: 0.8, reasoning: "matches" },
      suggestedSubtopic: { id: null, title: "Newton's first law", confidence: 0.7, reasoning: "law" },
    };
    stubAi(200, "```json\n" + JSON.stringify(suggestion) + "\n```");
    const r = await ask({ questionText: "What is inertia?", subjectId: "s1", subjectName: "Physics" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, suggestion);
    globalThis.fetch = realFetch;
  });

  it("maps 401 from the provider", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    stubAi(401, "no");
    const r = await ask({ questionText: "What is inertia?", subjectId: "s1" });
    assert.equal(r.status, 401);
    globalThis.fetch = realFetch;
  });
});
