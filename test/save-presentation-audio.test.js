import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { startServer, stopServer, q } from "./helpers.js";
import { router } from "../functions/save-presentation-audio/index.js";

// Backblaze B2 is replaced by a local stub (B2_API_BASE). No real host is contacted.
let stub;
let stubBase;
let uploads = []; // { name, bytes }
let failUploadsFor = null; // file-name fragment that always fails to upload
let fnServer;
let fnBase;
const savedEnv = {};
const ENV_KEYS = ["B2_KEY_ID", "B2_APPLICATION_KEY", "B2_BUCKET_ID", "B2_BUCKET_NAME", "B2_API_BASE", "B2_PUBLIC_BASE"];
const cacheIds = [];

// A WAV file: 44-byte header (mono, 16-bit, given sample rate) followed by `seconds` of silence.
function wavBase64(seconds, sampleRate = 22050) {
  const dataLen = sampleRate * 2 * seconds;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataLen, 40);
  return buf.toString("base64");
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function save(body) {
  const res = await fetch(`${fnBase}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe("save-presentation-audio", () => {
  before(async () => {
    await startServer();
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

    stub = http.createServer(async (req, res) => {
      const body = await readBody(req);
      const send = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.url === "/b2api/v2/b2_authorize_account") {
        return send(200, { apiUrl: stubBase, authorizationToken: "auth-tok" });
      }
      if (req.url === "/b2api/v2/b2_get_upload_url") {
        return send(200, { uploadUrl: `${stubBase}/upload`, authorizationToken: "up-tok" });
      }
      if (req.url === "/upload") {
        const name = decodeURIComponent(req.headers["x-bz-file-name"]);
        if (failUploadsFor && name.includes(failUploadsFor)) return send(500, { message: "nope" });
        uploads.push({ name, bytes: body.length });
        return send(200, { fileId: "f" });
      }
      send(404, {});
    });
    stub.listen(0, "127.0.0.1");
    await once(stub, "listening");
    stubBase = `http://127.0.0.1:${stub.address().port}`;

    process.env.B2_KEY_ID = "test-key-id";
    process.env.B2_APPLICATION_KEY = "test-app-key";
    process.env.B2_BUCKET_ID = "test-bucket-id";
    process.env.B2_BUCKET_NAME = "test-bucket";
    process.env.B2_API_BASE = stubBase;
    process.env.B2_PUBLIC_BASE = `${stubBase}/file`;

    const app = express();
    app.use(express.json({ limit: "20mb" }));
    app.use("/", router);
    fnServer = app.listen(0, "127.0.0.1");
    await once(fnServer, "listening");
    fnBase = `http://127.0.0.1:${fnServer.address().port}`;
  });

  after(async () => {
    try {
      if (cacheIds.length) await q("DELETE FROM public.teaching_qa_cache WHERE id = ANY($1)", [cacheIds]);
    } finally {
      for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
      await new Promise((r) => fnServer.close(r));
      await new Promise((r) => stub.close(r));
      await stopServer();
    }
  });

  it("400 when required fields are missing", async () => {
    const r = await save({ cache_id: "x", slides: [] });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "cache_id, slides array, and language are required");
  });

  it("500 when the bucket id is not configured", async () => {
    const saved = process.env.B2_BUCKET_ID;
    delete process.env.B2_BUCKET_ID;
    try {
      const r = await save({ cache_id: "x", slides: [], language: "en-IN" });
      assert.equal(r.status, 500);
      assert.equal(r.body.error, "B2_BUCKET_ID not configured");
    } finally {
      process.env.B2_BUCKET_ID = saved;
    }
  });

  it("uploads one WAV per slide, joins multi-chunk slides, and saves the URLs", async () => {
    const cacheId = randomUUID();
    cacheIds.push(cacheId);
    await q(
      "INSERT INTO public.teaching_qa_cache (id, question_hash, question_text, answer_text, variation_number) VALUES ($1, $2, 'q', 'a', 1)",
      [cacheId, "h-" + cacheId]
    );
    uploads = [];
    failUploadsFor = null;
    const r = await save({
      cache_id: cacheId,
      language: "en-IN",
      slides: [
        { slideIndex: 0, base64Chunks: [wavBase64(1)] },
        { slideIndex: 1, base64Chunks: [wavBase64(1), wavBase64(2)] },
        { slideIndex: 2, base64Chunks: [] },
      ],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.audioUrls.length, 2);
    assert.equal(r.body.failedCount, 0);
    assert.equal(r.body.audioUrls[0].audioUrl, `${stubBase}/file/test-bucket/ai-presentations/${cacheId}/en-IN/slide_0.wav`);
    assert.ok(Math.abs(r.body.audioUrls[0].duration - 1) < 0.01);
    assert.ok(Math.abs(r.body.audioUrls[1].duration - 3) < 0.01, "joined slide keeps all its audio");
    assert.ok(Math.abs(r.body.totalDuration - 4) < 0.01);

    // The joined file is one header plus both chunks' audio.
    const joined = uploads.find((u) => u.name.endsWith("slide_1.wav"));
    assert.equal(joined.bytes, 44 + 22050 * 2 * 3);

    const [row] = await q("SELECT slide_audio_urls, total_duration_seconds FROM public.teaching_qa_cache WHERE id = $1", [cacheId]);
    assert.equal(row.slide_audio_urls.language, "en-IN");
    assert.equal(row.slide_audio_urls.urls.length, 2);
    assert.ok(Math.abs(Number(row.total_duration_seconds) - 4) < 0.01);
  });

  it("counts a slide as failed when its upload keeps failing, and carries on", async () => {
    const cacheId = randomUUID();
    cacheIds.push(cacheId);
    await q(
      "INSERT INTO public.teaching_qa_cache (id, question_hash, question_text, answer_text, variation_number) VALUES ($1, $2, 'q', 'a', 1)",
      [cacheId, "h-" + cacheId]
    );
    uploads = [];
    failUploadsFor = "slide_7";
    try {
      const r = await save({
        cache_id: cacheId,
        language: "hi-IN",
        slides: [
          { slideIndex: 7, base64Chunks: [wavBase64(1)] },
          { slideIndex: 8, base64Chunks: [wavBase64(1)] },
        ],
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.audioUrls.length, 1);
      assert.equal(r.body.audioUrls[0].slideIndex, 8);
      assert.equal(r.body.failedCount, 1);
    } finally {
      failUploadsFor = null;
    }
  });
});
