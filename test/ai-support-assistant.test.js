import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { q } from "./helpers.js";
import { router } from "../functions/ai-support-assistant/index.js";
import { mountRouter, closeDb } from "./_group00-harness.js";

let app;
const ask = (body) => app.post("/", body);
const realFetch = globalThis.fetch;
let savedConfig;
let hadConfig;
const messages = [{ role: "user", content: "I cannot log in" }];

// Stubs the provider with a streamed body (or an error status).
function stubAi(status, text) {
  globalThis.fetch = (url, opts) => {
    if (String(url).startsWith("https://api.openai.com/")) {
      return Promise.resolve(new Response(text, { status, headers: { "Content-Type": "text/event-stream" } }));
    }
    return realFetch(url, opts);
  };
}
async function setConfig(value) {
  const updated = await q("UPDATE public.ai_settings SET setting_value = $1 WHERE setting_key = 'ai_api_config' RETURNING id", [value]);
  if (updated.length === 0) await q("INSERT INTO public.ai_settings (setting_key, setting_value) VALUES ('ai_api_config', $1)", [value]);
}

describe("ai-support-assistant", () => {
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

  it("requires a messages array", async () => {
    const r = await ask({ ticketId: "t1" });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "Messages array is required");
  });

  it("returns 503 when no AI provider is configured", async () => {
    await setConfig({ enabled: false });
    const r = await ask({ messages });
    assert.equal(r.status, 503);
  });

  it("relays the provider stream as text/event-stream (stubbed provider)", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    stubAi(200, 'data: {"delta":"Try resetting"}\n\ndata: [DONE]\n\n');
    const r = await ask({ messages });
    assert.equal(r.status, 200);
    assert.match(r.body, /Try resetting/);
    assert.match(r.body, /\[DONE\]/);
    globalThis.fetch = realFetch;
  });

  it("maps 429 and 401 from the provider", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    stubAi(429, "slow");
    assert.equal((await ask({ messages })).status, 429);
    stubAi(401, "no");
    assert.equal((await ask({ messages })).status, 401);
    globalThis.fetch = realFetch;
  });
});
