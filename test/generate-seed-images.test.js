import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { serveRouter, hitAt } from "./route-harness.js";
import { router, hooks } from "../functions/generate-seed-images/index.js";

const UPLOAD_ROOT = path.resolve(process.env.UPLOAD_DIR || path.join(process.cwd(), "storage-data"));
const PNG_B64 = Buffer.from("fake-png-bytes").toString("base64");

describe("generate-seed-images", () => {
  let r;
  let user;
  let savedRow;
  const realFetch = hooks.fetch;
  before(async () => {
    await startServer();
    r = await serveRouter("/functions/v1/generate-seed-images", router);
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
    // Remove only the files this test wrote. The folder may hold real uploads.
    const dir = path.join(UPLOAD_ROOT, "question-images", "subject");
    for (const name of await fs.readdir(dir).catch(() => [])) {
      if (name.startsWith("test-seed-")) await fs.rm(path.join(dir, name), { force: true });
    }
    await r.close();
    await stopServer();
  });

  const setConfig = async (value) => {
    await q("DELETE FROM public.ai_settings WHERE setting_key = 'ai_api_config'");
    await q("INSERT INTO public.ai_settings (setting_key, setting_value) VALUES ('ai_api_config', $1)", [JSON.stringify(value)]);
  };
  const body = { entityType: "subject", entityName: "Test Seed", entityDescription: "maths" };

  it("requires a Bearer token", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/generate-seed-images", { body });
    assert.equal(res.status, 401);
  });

  it("returns 503 when Google is not the configured provider", async () => {
    await setConfig({ enabled: true, provider: "openai", openai_api_key: "test-key-not-real" });
    const res = await hitAt(r.base, "POST", "/functions/v1/generate-seed-images", {
      body,
      headers: { Authorization: `Bearer ${user.access}` },
    });
    assert.equal(res.status, 503);
    assert.equal(res.body.success, false);
  });

  it("maps a 429 from Google to 429", async () => {
    await setConfig({ enabled: true, provider: "google", google_api_key: "test-key-not-real" });
    hooks.fetch = async () => new Response("{}", { status: 429 });
    const res = await hitAt(r.base, "POST", "/functions/v1/generate-seed-images", {
      body,
      headers: { Authorization: `Bearer ${user.access}` },
    });
    assert.equal(res.status, 429);
    assert.equal(res.body.success, false);
  });

  it("maps a 403 from Google to 403 with a key message", async () => {
    hooks.fetch = async () => new Response("{}", { status: 403 });
    const res = await hitAt(r.base, "POST", "/functions/v1/generate-seed-images", {
      body,
      headers: { Authorization: `Bearer ${user.access}` },
    });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /unauthorized Google API key/);
  });

  it("stores a returned image and gives a signed URL, with Google stubbed", async () => {
    hooks.fetch = async () =>
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG_B64 } }] } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const res = await hitAt(r.base, "POST", "/functions/v1/generate-seed-images", {
      body: { entityType: "subject", entityName: "Test Seed", entityDescription: "maths" },
      headers: { Authorization: `Bearer ${user.access}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.match(res.body.imageUrl, /\/storage\/v1\/object\/sign\/question-images\/subject\/test-seed-\d+\.png\?/);
  });
});
