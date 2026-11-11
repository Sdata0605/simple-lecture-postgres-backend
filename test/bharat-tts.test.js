import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { serveRouter, startUpstream, setEnv } from "./router-harness.js";
import { router } from "../functions/bharat-tts/index.js";

describe("bharat-tts", () => {
  let svc, up, restore;
  before(async () => {
    svc = await serveRouter(router);
    up = await startUpstream((req) => {
      if (req.url === "/health") return { status: 200, body: "{}" };
      return { status: 200, type: "audio/wav", body: "RIFFfake" };
    });
    restore = setEnv({ BHARAT_TTS_BASE_URL: up.base });
  });
  after(async () => {
    restore?.();
    await svc?.close();
    await up?.close();
  });

  it("requires a prompt", async () => {
    const r = await svc.post({});
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { ok: false, error: "prompt is required" });
  });

  it("reports an unreachable server when none is configured", async () => {
    const off = setEnv({ BHARAT_TTS_BASE_URL: undefined });
    try {
      const r = await svc.post({ prompt: "Hello" });
      assert.equal(r.body.code, "BHARAT_TTS_UNREACHABLE");
    } finally {
      off();
    }
  });

  it("returns base64 WAV audio for a short prompt", async () => {
    const r = await svc.post({ prompt: "Hello class" });
    assert.equal(r.body.ok, true);
    assert.equal(r.body.isChunked, false);
    assert.equal(r.body.mimeType, "audio/wav");
    assert.equal(Buffer.from(r.body.audioContent, "base64").toString(), "RIFFfake");
  });
});
