import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { serveRouter, hitAt } from "./route-harness.js";
import { router, hooks, pickProvider } from "../functions/forum-ai-reply/index.js";

describe("forum-ai-reply", () => {
  let r;
  let user;
  let savedRow;
  const savedSvc = process.env.SERVICE_KEY;
  const realFetch = hooks.fetch;
  before(async () => {
    await startServer();
    r = await serveRouter("/functions/v1/forum-ai-reply", router);
    user = await makeUser();
    process.env.SERVICE_KEY = "test-service-key-not-real";
    const rows = await q("SELECT setting_value FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    savedRow = rows.length ? rows[0].setting_value : undefined;
  });
  after(async () => {
    hooks.fetch = realFetch;
    await q("DELETE FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    if (savedRow !== undefined) {
      await q("INSERT INTO public.ai_settings (setting_key, setting_value) VALUES ('ai_api_config', $1)", [JSON.stringify(savedRow)]);
    }
    if (savedSvc === undefined) delete process.env.SERVICE_KEY;
    else process.env.SERVICE_KEY = savedSvc;
    await r.close();
    await stopServer();
  });

  const setConfig = async (value) => {
    await q("DELETE FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    await q("INSERT INTO public.ai_settings (setting_key, setting_value) VALUES ('ai_api_config', $1)", [JSON.stringify(value)]);
  };

  it("requires a user token or the service key", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/forum-ai-reply", { body: { checkOnly: true } });
    assert.equal(res.status, 401);
  });

  it("returns 503 when no provider is configured", async () => {
    await setConfig({ enabled: false });
    const res = await hitAt(r.base, "POST", "/functions/v1/forum-ai-reply", {
      body: { checkOnly: true },
      headers: { "x-service-key": process.env.SERVICE_KEY },
    });
    assert.equal(res.status, 503);
  });

  it("requires postId when not in checkOnly mode", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    const res = await hitAt(r.base, "POST", "/functions/v1/forum-ai-reply", {
      body: {},
      headers: { Authorization: `Bearer ${user.access}` },
    });
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: "postId is required" });
  });

  it("reports 'Post not found' for an unknown post", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/forum-ai-reply", {
      body: { postId: "00000000-0000-4000-8000-000000000000" },
      headers: { Authorization: `Bearer ${user.access}` },
    });
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: "Post not found" });
  });

  it("checkOnly with nothing to answer processes zero posts, with the AI stubbed", async () => {
    let calls = 0;
    hooks.fetch = async () => {
      calls += 1;
      return new Response("{}", { status: 500 });
    };
    const res = await hitAt(r.base, "POST", "/functions/v1/forum-ai-reply", {
      body: { checkOnly: true },
      headers: { "x-service-key": process.env.SERVICE_KEY },
    });
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.processed, "number");
    assert.equal(calls, res.body.processed, "one AI call per processed post");
  });

  it("pickProvider chooses by provider name", () => {
    assert.equal(pickProvider({ enabled: true, provider: "openrouter", openrouter_api_key: "k" }).model, "google/gemini-2.5-flash");
    assert.equal(pickProvider({ enabled: true, provider: "nope", openai_api_key: "k" }), null);
  });
});
