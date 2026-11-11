import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { q } from "./helpers.js";
import { router } from "../functions/ai-compare-math-answers/index.js";
import { mountRouter, closeDb } from "./_group00-harness.js";

let app;
const ask = (body) => app.post("/", body);
const items = [{ id: "a1", user_answer: "1/2", correct_answer: "0.5" }];
let savedConfig;
let hadConfig;
const realFetch = globalThis.fetch;

// Replaces external AI calls with a canned reply. Local calls (the test server) go through.
function stubAi(handler) {
  globalThis.fetch = (url, opts) => {
    if (String(url).startsWith("https://api.openai.com/")) return Promise.resolve(handler(opts));
    return realFetch(url, opts);
  };
}
const reply = (status, bodyObj) =>
  new Response(typeof bodyObj === "string" ? bodyObj : JSON.stringify(bodyObj), { status });

async function setConfig(value) {
  const updated = await q(
    "UPDATE public.ai_settings SET setting_value = $1 WHERE setting_key = 'ai_api_config' RETURNING id",
    [value]
  );
  if (updated.length === 0) {
    await q("INSERT INTO public.ai_settings (setting_key, setting_value) VALUES ('ai_api_config', $1)", [value]);
  }
}

describe("ai-compare-math-answers", () => {
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

  it("rejects an empty or missing items list with 400", async () => {
    const r = await ask({ items: [] });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "No items provided for comparison");
    assert.equal((await ask({})).status, 400);
  });

  it("returns 503 when no AI provider is configured", async () => {
    await setConfig({ enabled: false });
    const r = await ask({ items });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /AI API not configured/);
  });

  it("returns the parsed AI results (stubbed provider)", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    stubAi(() => reply(200, { choices: [{ message: { content: '```json\n{"results":[{"id":"a1","is_equivalent":true}]}\n```' } }] }));
    const r = await ask({ items });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { results: [{ id: "a1", is_equivalent: true }] });
  });

  it("maps provider 429 and 401 to the same status with a message", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    stubAi(() => reply(429, "rate"));
    const limited = await ask({ items });
    assert.equal(limited.status, 429);
    stubAi(() => reply(401, "bad key"));
    const denied = await ask({ items });
    assert.equal(denied.status, 401);
    assert.match(denied.body.error, /Invalid or unauthorized API key/);
    globalThis.fetch = realFetch;
  });
});
