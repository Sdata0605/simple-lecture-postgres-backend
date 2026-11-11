import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { serveRouter, hitAt } from "./route-harness.js";
import { router, hooks, numericToLetter, extractAnswerKey } from "../functions/extract-questions-preview/index.js";

describe("extract-questions-preview", () => {
  let r;
  let user;
  let savedRow;
  const realFetch = hooks.fetch;
  before(async () => {
    await startServer();
    r = await serveRouter("/functions/v1/extract-questions-preview", router);
    user = await makeUser();
    const rows = await q("SELECT setting_value FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    savedRow = rows.length ? rows[0].setting_value : undefined;
  });
  after(async () => {
    hooks.fetch = realFetch;
    await q("DELETE FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    if (savedRow !== undefined) {
      await q("INSERT INTO public.ai_settings (setting_key, setting_value) VALUES ('ai_api_config', $1)", [JSON.stringify(savedRow)]);
    }
    await r.close();
    await stopServer();
  });

  it("requires a service key or user token", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/extract-questions-preview", { body: {} });
    assert.equal(res.status, 401);
  });

  it("reports NO_CONTENT for short input", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/extract-questions-preview", {
      body: { contentMarkdown: "short" },
      headers: { Authorization: `Bearer ${user.access}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.errorCode, "NO_CONTENT");
  });

  it("reports AI_NOT_CONFIGURED when no provider is enabled", async () => {
    await q("DELETE FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    await q("INSERT INTO public.ai_settings (setting_key, setting_value) VALUES ('ai_api_config', $1)", [
      JSON.stringify({ enabled: false }),
    ]);
    const body = { contentMarkdown: "1. What is 2+2? (A) 3 (B) 4 Answer: B. ".repeat(10) };
    const res = await hitAt(r.base, "POST", "/functions/v1/extract-questions-preview", {
      body,
      headers: { Authorization: `Bearer ${user.access}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.errorCode, "AI_NOT_CONFIGURED");
  });

  it("reads an MCQ answer key from a table-style answer section", () => {
    const text = "Answers\n1. A\n2. C\n3. B\n";
    const key = extractAnswerKey(text);
    assert.equal(key.get(2), "C");
    assert.equal(numericToLetter("3"), "C");
  });
});
