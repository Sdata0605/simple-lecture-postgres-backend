import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { once } from "node:events";
import { startServer, stopServer } from "./helpers.js";
import { router, splitTextIntoChunks } from "../functions/sarvam-tts/index.js";

// Sarvam is replaced by a local stub (SARVAM_API_URL). No real request leaves the machine.
let stub;
let stubMode = "ok"; // ok | fail500 | rate429 | noaudio
let stubSeen = [];
let fnServer;
let fnBase;
const savedEnv = {};

async function tts(body) {
  const res = await fetch(`${fnBase}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe("sarvam-tts", () => {
  before(async () => {
    await startServer();
    for (const k of ["SARVAM_API_KEY", "SARVAM_API_URL"]) savedEnv[k] = process.env[k];

    stub = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const payload = JSON.parse(raw || "{}");
        stubSeen.push({ key: req.headers["api-subscription-key"], speaker: payload.speaker, lang: payload.target_language_code, inputs: payload.inputs });
        if (stubMode === "fail500") {
          res.writeHead(500, { "Content-Type": "text/plain" });
          return res.end("upstream broke");
        }
        if (stubMode === "rate429") {
          res.writeHead(429);
          return res.end();
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(stubMode === "noaudio" ? { audios: [] } : { audios: [`AUDIO(${payload.inputs[0].length})`] }));
      });
    });
    stub.listen(0, "127.0.0.1");
    await once(stub, "listening");
    process.env.SARVAM_API_URL = `http://127.0.0.1:${stub.address().port}/text-to-speech`;
    process.env.SARVAM_API_KEY = "test-sarvam-key";

    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/", router);
    fnServer = app.listen(0, "127.0.0.1");
    await once(fnServer, "listening");
    fnBase = `http://127.0.0.1:${fnServer.address().port}`;
  });

  after(async () => {
    for (const k of Object.keys(savedEnv)) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await new Promise((r) => fnServer.close(r));
    await new Promise((r) => stub.close(r));
    await stopServer();
  });

  it("answers OPTIONS", async () => {
    const r = await fetch(`${fnBase}/`, { method: "OPTIONS" });
    assert.equal(r.status, 200);
  });

  it("400 for empty text", async () => {
    const r = await tts({ text: "   " });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "No text provided");
  });

  it("500 when the Sarvam key is not configured", async () => {
    const saved = process.env.SARVAM_API_KEY;
    delete process.env.SARVAM_API_KEY;
    try {
      const r = await tts({ text: "hello" });
      assert.equal(r.status, 500);
      assert.equal(r.body.error, "SARVAM_API_KEY not configured");
    } finally {
      process.env.SARVAM_API_KEY = saved;
    }
  });

  it("synthesises short text with the male voice and the mapped language", async () => {
    stubMode = "ok";
    stubSeen = [];
    const r = await tts({ text: "Hello there.", languageCode: "hi-IN", gender: "male" });
    assert.equal(r.status, 200);
    assert.equal(r.body.audioContent, "AUDIO(12)");
    assert.equal(r.body.isChunked, false);
    assert.equal(r.body.chunkCount, 1);
    assert.equal(r.body.voice, "abhilash");
    assert.equal(r.body.languageCode, "hi-IN");
    assert.equal(stubSeen[0].key, "test-sarvam-key");
  });

  it("uses the female voice and falls back to en-IN for an unknown language", async () => {
    stubMode = "ok";
    stubSeen = [];
    const r = await tts({ text: "Hi", languageCode: "fr-FR", gender: "female" });
    assert.equal(r.body.voice, "meera");
    assert.equal(r.body.languageCode, "en-IN");
    assert.equal(stubSeen[0].speaker, "meera");
  });

  it("chunks long text and returns one audio string per chunk", async () => {
    stubMode = "ok";
    stubSeen = [];
    const sentence = "This is a sentence about photosynthesis in plants. ";
    const r = await tts({ text: sentence.repeat(20) });
    assert.equal(r.status, 200);
    assert.equal(r.body.isChunked, true);
    assert.ok(r.body.chunkCount > 1);
    assert.equal(r.body.audioContent.length, r.body.chunkCount);
    assert.ok(stubSeen.every((s) => s.inputs[0].length <= 400));
  });

  it("maps an upstream error to 503 with the fallback flag", async () => {
    stubMode = "fail500";
    const r = await tts({ text: "boom" });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "Sarvam TTS failed");
    assert.equal(r.body.fallback, true);
    assert.equal(r.body.details, "upstream broke");
  });

  it("reports a reply with no audio as a failure", async () => {
    stubMode = "noaudio";
    const r = await tts({ text: "silence" });
    assert.equal(r.status, 503);
    assert.equal(r.body.details, "No audio in response");
  });

  it("gives up after rate-limit retries", async () => {
    stubMode = "rate429";
    try {
      const r = await tts({ text: "busy" });
      assert.equal(r.status, 503);
      assert.equal(r.body.details, "Max retries exceeded due to rate limiting");
    } finally {
      stubMode = "ok";
    }
  });
});

describe("sarvam-tts chunking", () => {
  it("never produces a chunk over the limit, and keeps all the words in order", () => {
    const text = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const chunks = splitTextIntoChunks(text);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((c) => c.length <= 400));
    assert.equal(chunks.join(" ").split(/\s+/).join(" "), text);
  });

  it("returns a short text as a single chunk", () => {
    assert.deepEqual(splitTextIntoChunks("  short text  "), ["short text"]);
  });
});
