import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { q } from "./helpers.js";
import { router } from "../functions/ai-generate-topic-content/index.js";
import { mountRouter, closeDb } from "./_group00-harness.js";

let app;
const ask = (body) => app.post("/", body);
const realFetch = globalThis.fetch;
let savedConfig;
let hadConfig;
const body = { topicTitle: "Velocity", chapterTitle: "Motion", subjectName: "Physics", categoryName: "Science", estimatedDurationMinutes: 30 };

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

describe("ai-generate-topic-content", () => {
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

  it("returns 503 when no AI provider is configured", async () => {
    await setConfig({ enabled: false });
    assert.equal((await ask(body)).status, 503);
  });

  it("returns the parsed pack when the structure is complete (stubbed provider)", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    const pack = { content: "# Velocity", examples: [{ title: "E1" }], practiceQuestions: [{ type: "mcq" }] };
    stubAi(200, "```json\n" + JSON.stringify(pack) + "\n```");
    const r = await ask(body);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, pack);
    globalThis.fetch = realFetch;
  });

  it("rejects a pack missing sections with 500", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    stubAi(200, JSON.stringify({ content: "x", examples: [] }));
    const r = await ask(body);
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "Invalid content structure from AI");
    globalThis.fetch = realFetch;
  });

  it("maps 429 from the provider", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    stubAi(429, "slow");
    assert.equal((await ask(body)).status, 429);
    globalThis.fetch = realFetch;
  });
});
