import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, q } from "./helpers.js";
import { serveRouter } from "./router-harness.js";
import { router } from "../functions/ai-tutor-chat/index.js";

describe("ai-tutor-chat", () => {
  let svc, prev;
  before(async () => {
    await startServer();
    svc = await serveRouter(router);
    prev = await q("SELECT setting_value FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    // Disabled config, so no real provider is ever called.
    if (prev.length) await q("UPDATE public.ai_settings SET setting_value = $1 WHERE setting_key = 'ai_api_config'", [{ enabled: false }]);
    else await q("INSERT INTO public.ai_settings (setting_key, setting_value) VALUES ('ai_api_config', $1)", [{ enabled: false }]);
  });
  after(async () => {
    if (prev.length) await q("UPDATE public.ai_settings SET setting_value = $1 WHERE setting_key = 'ai_api_config'", [prev[0].setting_value]);
    else await q("DELETE FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    await svc?.close();
    await stopServer();
  });

  it("requires a messages array", async () => {
    const r = await svc.post({ messages: "hi" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "messages array is required");
  });

  it("returns 503 when no AI provider is enabled", async () => {
    const r = await svc.post({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /AI API not configured/);
  });
});
