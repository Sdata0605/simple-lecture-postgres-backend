import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { serveRouter, hitAt } from "./route-harness.js";
import { router, hooks, pickProvider } from "../functions/llm-verify-questions/index.js";

describe("llm-verify-questions", () => {
  let r;
  let user;
  let savedConfig;
  let hadConfig;
  const realFetch = hooks.fetch;
  before(async () => {
    await startServer();
    r = await serveRouter("/functions/v1/llm-verify-questions", router);
    user = await makeUser();
    const rows = await q("SELECT setting_value FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    hadConfig = rows.length > 0;
    savedConfig = hadConfig ? rows[0].setting_value : null;
  });
  after(async () => {
    hooks.fetch = realFetch;
    await q("DELETE FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    if (hadConfig) {
      await q(
        "INSERT INTO public.ai_settings (setting_key, setting_value) VALUES ('ai_api_config', $1)",
        [JSON.stringify(savedConfig)],
      );
    }
    await r.close();
    await stopServer();
  });

  it("requires a Bearer token", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/llm-verify-questions", { body: { questionIds: [] } });
    assert.equal(res.status, 401);
  });

  it("picks a provider only when enabled with its key", () => {
    assert.equal(pickProvider({ enabled: false, provider: "openai", openai_api_key: "k" }), null);
    assert.equal(pickProvider({ enabled: true, provider: "openai" }), null);
    const p = pickProvider({ enabled: true, provider: "openai", openai_api_key: "k" });
    assert.equal(p.apiUrl, "https://api.openai.com/v1/chat/completions");
    assert.equal(p.model, "gpt-4o-mini");
    assert.equal(pickProvider({ enabled: true, provider: "google", google_api_key: "k", default_model: "m" }).model, "m");
  });

  it("returns 503 when no provider is configured", async () => {
    await q("DELETE FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    const res = await hitAt(r.base, "POST", "/functions/v1/llm-verify-questions", {
      body: { questionIds: [] },
      headers: { Authorization: `Bearer ${user.access}` },
    });
    assert.equal(res.status, 503);
    assert.match(res.body.error, /not configured/);
  });

  it("returns an empty result for unknown question ids, with the AI stubbed", async () => {
    await q("DELETE FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    await q(
      "INSERT INTO public.ai_settings (setting_key, setting_value) VALUES ('ai_api_config', $1)",
      [JSON.stringify({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" })],
    );
    let calls = 0;
    hooks.fetch = async () => {
      calls += 1;
      return new Response("{}", { status: 500 });
    };
    const res = await hitAt(r.base, "POST", "/functions/v1/llm-verify-questions", {
      body: { questionIds: ["00000000-0000-4000-8000-000000000000"] },
      headers: { Authorization: `Bearer ${user.access}` },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { success: true, results: [] });
    assert.equal(calls, 0);
  });
});
