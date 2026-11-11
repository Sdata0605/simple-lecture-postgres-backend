import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { q } from "./helpers.js";
import { router } from "../functions/ai-generate-curriculum/index.js";
import { mountRouter, closeDb } from "./_group00-harness.js";

let app;
const ask = (body) => app.post("/", body);
const realFetch = globalThis.fetch;
let savedConfig;
let hadConfig;

function stubAi(status, payload) {
  globalThis.fetch = (url, opts) => {
    if (String(url).startsWith("https://api.openai.com/")) {
      return Promise.resolve(new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status }));
    }
    return realFetch(url, opts);
  };
}
async function setConfig(value) {
  const updated = await q("UPDATE public.ai_settings SET setting_value = $1 WHERE setting_key = 'ai_api_config' RETURNING id", [value]);
  if (updated.length === 0) await q("INSERT INTO public.ai_settings (setting_key, setting_value) VALUES ('ai_api_config', $1)", [value]);
}

describe("ai-generate-curriculum", () => {
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

  it("requires subjectName", async () => {
    const r = await ask({});
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "Subject name is required");
  });

  it("returns 503 when no AI provider is configured", async () => {
    await setConfig({ enabled: false });
    assert.equal((await ask({ subjectName: "Physics" })).status, 503);
  });

  it("reads the curriculum from the tool call arguments (stubbed provider)", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    const chapters = [{ chapter_number: 1, title: "Motion", description: "d", topics: [] }];
    stubAi(200, { choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ chapters }) } }] } } ] });
    const r = await ask({ subjectName: "Physics", categoryName: "Science" });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.deepEqual(r.body.curriculum, chapters);
    assert.equal(r.body.metadata.chaptersCount, 1);
    globalThis.fetch = realFetch;
  });

  it("a reply without a tool call is a 500", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    stubAi(200, { choices: [{ message: { content: "no tool" } }] });
    const r = await ask({ subjectName: "Physics" });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "No curriculum data generated");
    globalThis.fetch = realFetch;
  });
});
