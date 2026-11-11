import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { q } from "./helpers.js";
import { router } from "../functions/ai-sales-assistant/index.js";
import { mountRouter, closeDb } from "./_group00-harness.js";

let app;
const realFetch = globalThis.fetch;
const marker = `sales-test-${crypto.randomUUID()}`;
let leadId;
let savedConfig;
let hadConfig;
let aiCalls = 0;

const LONG_REPLY = "Hello there! I am Rahul, and I can help you pick the right course for your exam plans today.";

function stubAi(text) {
  globalThis.fetch = (url, opts) => {
    if (String(url).startsWith("https://api.openai.com/")) {
      aiCalls++;
      const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;
      return Promise.resolve(new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    }
    return realFetch(url, opts);
  };
}
async function setConfig(value) {
  const updated = await q("UPDATE public.ai_settings SET setting_value = $1 WHERE setting_key = 'ai_api_config' RETURNING id", [value]);
  if (updated.length === 0) await q("INSERT INTO public.ai_settings (setting_key, setting_value) VALUES ('ai_api_config', $1)", [value]);
}
const post = (body) => app.post("/", body);

// The handler ends the SSE response before it saves the lead history and caches the answer
// (functions/ai-sales-assistant/index.js: res.end() before the UPDATE and the cache INSERT).
// So the test polls for those side effects instead of reading them the instant the response ends.
async function eventually(fn, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("ai-sales-assistant", () => {
  before(async () => {
    app = await mountRouter("/", router);
    const [lead] = await q("INSERT INTO public.sales_leads (name, lead_status) VALUES ($1, 'new') RETURNING id", [marker]);
    leadId = lead.id;
    const rows = await q("SELECT setting_value FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    hadConfig = rows.length > 0;
    savedConfig = hadConfig ? rows[0].setting_value : null;
  });
  after(async () => {
    globalThis.fetch = realFetch;
    await q("DELETE FROM public.sales_faq_cache WHERE question_text LIKE $1", [`%${marker}%`]);
    await q("DELETE FROM public.sales_leads WHERE id = $1", [leadId]);
    if (hadConfig) {
      await q("UPDATE public.ai_settings SET setting_value = $1 WHERE setting_key = 'ai_api_config'", [savedConfig]);
    } else {
      await q("DELETE FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    }
    await app.close();
    await closeDb();
  });

  it("requires leadId and a messages array", async () => {
    const r = await post({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "leadId and messages array are required");
  });

  it("returns 503 when no AI provider is configured", async () => {
    await setConfig({ enabled: false });
    const r = await post({ leadId, messages: [{ role: "user", content: `Which course is best ${marker}?` }] });
    assert.equal(r.status, 503);
  });

  it("streams the provider reply, saves the conversation, and caches a short answer", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    stubAi(LONG_REPLY);
    const question = `Tell me about the courses ${marker}`;
    const messages = [{ role: "user", content: question }];
    const before = aiCalls;
    const r = await post({ leadId, messages, counselorGender: "female" });
    assert.equal(r.status, 200);
    assert.match(r.body, /I am Rahul/);
    assert.match(r.body, /\[DONE\]/);
    assert.equal(aiCalls, before + 1);

    const history = await eventually(async () => {
      const rows = await q("SELECT conversation_history FROM public.sales_leads WHERE id = $1", [leadId]);
      return rows[0]?.conversation_history?.length ? rows[0].conversation_history : null;
    });
    assert.equal(history[0].content, question);

    const cached = await eventually(async () => {
      const rows = await q("SELECT answer_text FROM public.sales_faq_cache WHERE question_text = $1", [question]);
      return rows.length ? rows : null;
    });
    assert.equal(cached.length, 1);
  });

  it("answers an exact repeat from the cache without calling the provider", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    stubAi("SHOULD NOT BE USED");
    const question = `Tell me about the courses ${marker}`;
    const before = aiCalls;
    const r = await post({ leadId, messages: [{ role: "user", content: question }] });
    assert.equal(r.status, 200);
    assert.match(r.body, /I am Rahul/);
    assert.equal(aiCalls, before);
    assert.doesNotMatch(r.body, /SHOULD NOT BE USED/);
    globalThis.fetch = realFetch;
  });
});
