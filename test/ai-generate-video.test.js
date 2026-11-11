import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { q } from "./helpers.js";
import { router } from "../functions/ai-generate-video/index.js";
import { mountRouter, closeDb } from "./_group00-harness.js";

let app;
const ask = (body) => app.post("/", body);
const realFetch = globalThis.fetch;
let savedConfig;
let hadConfig;

function stubAi(content) {
  globalThis.fetch = (url, opts) => {
    if (String(url).startsWith("https://api.openai.com/")) {
      return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }));
    }
    return realFetch(url, opts);
  };
}
async function setConfig(value) {
  const updated = await q("UPDATE public.ai_settings SET setting_value = $1 WHERE setting_key = 'ai_api_config' RETURNING id", [value]);
  if (updated.length === 0) await q("INSERT INTO public.ai_settings (setting_key, setting_value) VALUES ('ai_api_config', $1)", [value]);
}

describe("ai-generate-video", () => {
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
    const r = await ask({ content: "x" });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "Content and title are required");
  });

  it("returns 503 when no provider is configured", async () => {
    await setConfig({ enabled: true, provider: "openrouter", openrouter_api_key: "test-key-not-real" });
    const r = await ask({ content: "Notes", title: "Lesson 1" });
    assert.equal(r.status, 503);
  });

  it("returns the script with video_url null (stubbed provider)", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    stubAi("Stubbed video script.");
    const r = await ask({ content: "Notes", title: "Lesson 1", type: "science" });
    assert.equal(r.status, 200);
    assert.equal(r.body.script, "Stubbed video script.");
    assert.equal(r.body.video_url, null);
    assert.equal(r.body.metadata.status, "script_ready");
    globalThis.fetch = realFetch;
  });
});
