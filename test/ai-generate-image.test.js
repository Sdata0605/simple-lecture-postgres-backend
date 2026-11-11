import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { q } from "./helpers.js";
import { router } from "../functions/ai-generate-image/index.js";
import { mountRouter, closeDb } from "./_group00-harness.js";

let app;
const ask = (body) => app.post("/", body);
const realFetch = globalThis.fetch;
const courseId = crypto.randomUUID();
const uploadRoot = path.resolve(process.env.UPLOAD_DIR || path.join(process.cwd(), "storage-data"));
let savedConfig;
let hadConfig;

function stubOpenRouter(status, body) {
  globalThis.fetch = (url, opts) => {
    if (String(url).startsWith("https://openrouter.ai/")) {
      return Promise.resolve(new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
    }
    return realFetch(url, opts);
  };
}
async function setConfig(value) {
  const updated = await q("UPDATE public.ai_settings SET setting_value = $1 WHERE setting_key = 'ai_api_config' RETURNING id", [value]);
  if (updated.length === 0) await q("INSERT INTO public.ai_settings (setting_key, setting_value) VALUES ('ai_api_config', $1)", [value]);
}

describe("ai-generate-image", () => {
  before(async () => {
    app = await mountRouter("/", router);
    const rows = await q("SELECT setting_value FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    hadConfig = rows.length > 0;
    savedConfig = hadConfig ? rows[0].setting_value : null;
  });
  after(async () => {
    globalThis.fetch = realFetch;
    await fs.rm(path.join(uploadRoot, "course-thumbnails", courseId), { recursive: true, force: true });
    if (hadConfig) {
      await q("UPDATE public.ai_settings SET setting_value = $1 WHERE setting_key = 'ai_api_config'", [savedConfig]);
    } else {
      await q("DELETE FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    }
    await app.close();
    await closeDb();
  });

  it("requires a prompt", async () => {
    const r = await ask({ courseId });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "Prompt is required");
  });

  it("returns 503 unless OpenRouter is enabled with a key", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    const r = await ask({ prompt: "a lamp", courseId });
    assert.equal(r.status, 503);
    assert.match(r.body.error, /OpenRouter image generation is not configured/);
  });

  it("maps 402 to a credits message and 429 to a rate-limit message", async () => {
    await setConfig({ enabled: true, provider: "openrouter", openrouter_api_key: "test-key-not-real" });
    stubOpenRouter(402, "no credits");
    const credits = await ask({ prompt: "a lamp", courseId });
    assert.equal(credits.status, 402);
    stubOpenRouter(429, "slow down");
    const limited = await ask({ prompt: "a lamp", courseId });
    assert.equal(limited.status, 429);
    globalThis.fetch = realFetch;
  });

  it("stores the returned image and gives a signed link (stubbed provider)", async () => {
    await setConfig({ enabled: true, provider: "openrouter", openrouter_api_key: "test-key-not-real" });
    const png = Buffer.from("fake-png-bytes").toString("base64");
    stubOpenRouter(200, { data: [{ b64_json: png, media_type: "image/png" }] });
    const r = await ask({ prompt: "a lamp", courseId });
    globalThis.fetch = realFetch;
    assert.equal(r.status, 200);
    assert.match(r.body.imageUrl, /\/storage\/v1\/object\/sign\/course-thumbnails\//);
    const dir = path.join(uploadRoot, "course-thumbnails", courseId);
    const files = await fs.readdir(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^ai_\d+\.png$/);
  });
});
