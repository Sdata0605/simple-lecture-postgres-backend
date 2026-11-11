import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser } from "./helpers.js";
import { serveRouter, hitAt } from "./route-harness.js";
import { router } from "../functions/google-tts/index.js";

describe("google-tts", () => {
  let user;
  let r;
  const saved = process.env.GOOGLE_TTS_API_KEY;
  before(async () => {
    await startServer();
    r = await serveRouter("/functions/v1/google-tts", router);
    user = await makeUser();
  });
  after(async () => {
    if (saved === undefined) delete process.env.GOOGLE_TTS_API_KEY;
    else process.env.GOOGLE_TTS_API_KEY = saved;
    await r.close();
    await stopServer();
  });

  it("requires a Bearer token", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/google-tts", { body: { text: "hi" } });
    assert.equal(res.status, 401);
  });

  it("rejects empty text", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/google-tts", {
      body: { text: "   " },
      headers: { Authorization: `Bearer ${user.access}` },
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Text is required" });
  });

  it("returns 500 when GOOGLE_TTS_API_KEY is not configured", async () => {
    delete process.env.GOOGLE_TTS_API_KEY;
    const res = await hitAt(r.base, "POST", "/functions/v1/google-tts", {
      body: { text: "hello" },
      headers: { Authorization: `Bearer ${user.access}` },
    });
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: "TTS service not configured" });
  });
});
