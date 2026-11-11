import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { q } from "./helpers.js";
import { router } from "../functions/ai-generate-podcast/index.js";
import { mountRouter, closeDb } from "./_group00-harness.js";

let app;
const ask = (body) => app.post("/", body);
const realFetch = globalThis.fetch;
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

describe("ai-generate-podcast", () => {
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

  it("requires content and title", async () => {
    const r = await ask({ title: "Only a title" });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "Content and title are required");
  });

  it("returns 503 when no AI provider is configured", async () => {
    await setConfig({ enabled: false });
    const r = await ask({ content: "Some notes", title: "Episode 1" });
    assert.equal(r.status, 503);
  });

  it("returns the script with metadata and no audio (stubbed provider)", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    stubAi("Stubbed script text.");
    const r = await ask({ content: "Some notes", title: "Episode 1", type: "science" });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.script, "Stubbed script text.");
    assert.equal(r.body.audio_url, null);
    assert.equal(r.body.metadata.title, "Episode 1");
    assert.equal(r.body.metadata.status, "script_ready");
    globalThis.fetch = realFetch;
  });

  it("a provider error is a 500 with the status in the message", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    stubAi("boom", 502);
    const r = await ask({ content: "Some notes", title: "Episode 1" });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "AI API error: 502");
    globalThis.fetch = realFetch;
  });
});
