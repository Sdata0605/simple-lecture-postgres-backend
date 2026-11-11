import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { q } from "./helpers.js";
import { router } from "../functions/ai-generate-course-content/index.js";
import { mountRouter, closeDb } from "./_group00-harness.js";

let app;
const ask = (body) => app.post("/", body);
const realFetch = globalThis.fetch;
let savedConfig;
let hadConfig;

function stubAi(status, content) {
  globalThis.fetch = (url, opts) => {
    if (String(url).startsWith("https://api.openai.com/")) {
      const body = status === 200 ? JSON.stringify({ choices: [{ message: { content } }] }) : String(content);
      return Promise.resolve(new Response(body, { status }));
    }
    return realFetch(url, opts);
  };
}
async function setConfig(value) {
  const updated = await q("UPDATE public.ai_settings SET setting_value = $1 WHERE setting_key = 'ai_api_config' RETURNING id", [value]);
  if (updated.length === 0) await q("INSERT INTO public.ai_settings (setting_key, setting_value) VALUES ('ai_api_config', $1)", [value]);
}
const ctx = { courseName: "Physics 101", shortDescription: "Basics of physics" };

describe("ai-generate-course-content", () => {
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
    const r = await ask({ type: "description", context: ctx });
    assert.equal(r.status, 503);
  });

  it("parses a fenced JSON array for what_you_learn (stubbed provider)", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    stubAi(200, '```json\n["Explain motion", "Solve force problems"]\n```');
    const r = await ask({ type: "what_you_learn", context: ctx });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { content: ["Explain motion", "Solve force problems"] });
    globalThis.fetch = realFetch;
  });

  it("falls back to bullet lines for what_you_learn when the JSON does not parse", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    stubAi(200, "Intro line\n- Explain motion\n* Solve force problems");
    const r = await ask({ type: "what_you_learn", context: ctx });
    assert.deepEqual(r.body, { content: ["Explain motion", "Solve force problems"] });
    globalThis.fetch = realFetch;
  });

  it("returns plain text for description", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    stubAi(200, "A short course description.");
    const r = await ask({ type: "description", context: ctx });
    assert.deepEqual(r.body, { content: "A short course description." });
    globalThis.fetch = realFetch;
  });

  it("maps 429 and 401 from the provider", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    stubAi(429, "slow");
    assert.equal((await ask({ type: "faq_answer", context: { ...ctx, question: "Q?" } })).status, 429);
    stubAi(401, "no");
    const denied = await ask({ type: "faq_answer", context: { ...ctx, question: "Q?" } });
    assert.equal(denied.status, 401);
    globalThis.fetch = realFetch;
  });
});
