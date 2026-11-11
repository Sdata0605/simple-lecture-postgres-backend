import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { serveRouter, hitAt } from "./route-harness.js";
import { router, hooks, detectTopic, getFallbackImage } from "../functions/generate-blog-post/index.js";

describe("generate-blog-post", () => {
  let r;
  let user;
  let savedRow;
  const savedLovable = process.env.LOVABLE_API_KEY;
  const realFetch = hooks.fetch;
  const realSleep = hooks.sleep;
  before(async () => {
    await startServer();
    r = await serveRouter("/functions/v1/generate-blog-post", router);
    user = await makeUser();
    const rows = await q("SELECT setting_value FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    savedRow = rows.length ? rows[0].setting_value : undefined;
    delete process.env.LOVABLE_API_KEY;
  });
  after(async () => {
    hooks.fetch = realFetch;
    hooks.sleep = realSleep;
    await q("DELETE FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    if (savedRow !== undefined) {
      await q("INSERT INTO public.ai_settings (setting_key, setting_value) VALUES ('ai_api_config', $1)", [JSON.stringify(savedRow)]);
    }
    if (savedLovable !== undefined) process.env.LOVABLE_API_KEY = savedLovable;
    await r.close();
    await stopServer();
  });

  it("requires a service key or user token", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/generate-blog-post", { body: {} });
    assert.equal(res.status, 401);
  });

  it("returns 503 when AI is not enabled", async () => {
    await q("DELETE FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    await q("INSERT INTO public.ai_settings (setting_key, setting_value) VALUES ('ai_api_config', $1)", [
      JSON.stringify({ enabled: false }),
    ]);
    const res = await hitAt(r.base, "POST", "/functions/v1/generate-blog-post", {
      body: {},
      headers: { Authorization: `Bearer ${user.access}` },
    });
    assert.equal(res.status, 503);
  });

  it("stops with an error when every text provider fails (stubbed, no retries wait)", async () => {
    hooks.sleep = async () => {};
    await q("DELETE FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    await q("INSERT INTO public.ai_settings (setting_key, setting_value) VALUES ('ai_api_config', $1)", [
      JSON.stringify({ enabled: true, google_api_key: "test-key-not-real" }),
    ]);
    hooks.fetch = async () => new Response("bad", { status: 400 });
    const res = await hitAt(r.base, "POST", "/functions/v1/generate-blog-post", {
      body: {},
      headers: { Authorization: `Bearer ${user.access}` },
    });
    // 400 when there are no active courses in the database, otherwise 503 from the provider chain.
    assert.ok(res.status === 400 || res.status === 503, `unexpected status ${res.status}`);
  });

  it("picks a topic image from keywords and never repeats within one post", () => {
    assert.equal(detectTopic("Physics force and motion", ""), "physics");
    assert.equal(detectTopic("nothing here", ""), "general");
    const used = new Set();
    const first = getFallbackImage("Calculus integral", "", used);
    const second = getFallbackImage("Calculus integral", "", used);
    assert.notEqual(first, second);
    assert.equal(used.size, 2);
  });
});
