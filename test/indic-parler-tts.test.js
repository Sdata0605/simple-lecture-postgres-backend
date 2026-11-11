import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser } from "./helpers.js";
import { serveRouter, hitAt } from "./route-harness.js";
import { router, hooks, splitTextIntoChunks, concatenateWavBuffers } from "../functions/indic-parler-tts/index.js";

function wav(dataBytes) {
  const buf = Buffer.alloc(44 + dataBytes.length);
  buf.write("RIFF", 0);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(24000, 24);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  Buffer.from(dataBytes).copy(buf, 44);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

describe("indic-parler-tts", () => {
  let r;
  let user;
  const saved = { key: process.env.INDIC_PARLER_API_KEY, base: process.env.INDIC_PARLER_BASE_URL };
  const realFetch = hooks.fetch;
  const realSleep = hooks.sleep;
  before(async () => {
    await startServer();
    r = await serveRouter("/functions/v1/indic-parler-tts", router, { raw: false });
    user = await makeUser();
  });
  after(async () => {
    hooks.fetch = realFetch;
    hooks.sleep = realSleep;
    for (const [k, envName] of [["key", "INDIC_PARLER_API_KEY"], ["base", "INDIC_PARLER_BASE_URL"]]) {
      if (saved[k] === undefined) delete process.env[envName];
      else process.env[envName] = saved[k];
    }
    await r.close();
    await stopServer();
  });
  const auth = () => ({ Authorization: `Bearer ${user.access}` });

  it("requires a Bearer token", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/indic-parler-tts", { body: { text: "hi" } });
    assert.equal(res.status, 401);
  });

  it("rejects empty text", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/indic-parler-tts", { body: { text: "  " }, headers: auth() });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Text is required" });
  });

  it("returns 500 when the TTS server is not configured", async () => {
    delete process.env.INDIC_PARLER_API_KEY;
    delete process.env.INDIC_PARLER_BASE_URL;
    const res = await hitAt(r.base, "POST", "/functions/v1/indic-parler-tts", { body: { text: "hi" }, headers: auth() });
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: "TTS service not configured" });
  });

  it("splits long text at sentence boundaries and keeps every chunk under the limit", () => {
    assert.deepEqual(splitTextIntoChunks("short"), ["short"]);
    const text = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const chunks = splitTextIntoChunks(text, 100);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((c) => c.length <= 100));
    assert.equal(chunks.join(" ").replace(/\s+/g, " "), text.replace(/\s+/g, " "));
  });

  it("joins WAV parts into one file with a corrected size header", () => {
    const joined = Buffer.from(concatenateWavBuffers([wav([1, 2, 3]), wav([4, 5])]));
    assert.equal(joined.length, 44 + 5);
    assert.equal(joined.readUInt32LE(40), 5);
    assert.deepEqual([...joined.subarray(44)], [1, 2, 3, 4, 5]);
  });

  it("returns the joined WAV with the TTS server stubbed", async () => {
    process.env.INDIC_PARLER_API_KEY = "test-key-not-real";
    process.env.INDIC_PARLER_BASE_URL = "http://tts.example.test:8000";
    hooks.fetch = async (url) => {
      if (String(url).endsWith("/tts")) {
        return new Response(JSON.stringify({ status: "success", audio_url: "/audio/1.wav" }), { status: 200 });
      }
      return new Response(Buffer.from(wav([9, 9])), { status: 200 });
    };
    const res = await fetch(`${r.base}/functions/v1/indic-parler-tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${user.access}` },
      body: JSON.stringify({ text: "Hello there" }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "audio/wav");
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString(), "RIFF");
  });
});
