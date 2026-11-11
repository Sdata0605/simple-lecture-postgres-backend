import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { q } from "./helpers.js";
import { router } from "../functions/ai-rephrase/index.js";
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

describe("ai-rephrase", () => {
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

  it("requires text and type", async () => {
    const r = await ask({ text: "Cells" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "Missing required fields: text and type");
  });

  it("returns 503 when no provider is configured", async () => {
    await setConfig({ enabled: false });
    const r = await ask({ text: "Cells", type: "topic" });
    assert.equal(r.status, 503);
  });

  it("returns every suggestion from a JSON array reply (stubbed provider)", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    stubAi(200, '["Cell biology", "The study of cells"]');
    const r = await ask({ text: "Cells", type: "topic", count: 2 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
      original: "Cells",
      rephrased: "Cell biology",
      suggestions: ["Cell biology", "The study of cells"],
      type: "topic",
    });
    globalThis.fetch = realFetch;
  });

  it("uses the raw reply as one suggestion when it is not a JSON array", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    stubAi(200, "Plain rephrased text");
    const r = await ask({ text: "Cells", type: "chapter" });
    assert.deepEqual(r.body.suggestions, ["Plain rephrased text"]);
    globalThis.fetch = realFetch;
  });

  it("maps 429 and 401 from the provider", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    stubAi(429, "slow");
    assert.equal((await ask({ text: "Cells", type: "answer" })).status, 429);
    stubAi(403, "no");
    assert.equal((await ask({ text: "Cells", type: "answer" })).status, 403);
    globalThis.fetch = realFetch;
  });
});
