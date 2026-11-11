import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, base, call } from "./helpers.js";
import { upload, list, createSignedUrl, verifySignedToken, readFile } from "../functions/_shared/storage.js";
import { resolveGeminiVoice, parseWav, wrapWav, toCanonicalWav, extractAudio, styleFor } from "../functions/_shared/geminiTts.js";

const BUCKET = "reminder-audio-test";
const OWNER = "00000000-0000-4000-8000-000000000001";

describe("local storage with signed links", () => {
  before(startServer);
  after(stopServer);

  it("uploads, lists and reads a file", async () => {
    const bytes = Buffer.from("RIFFtest");
    await upload(BUCKET, `${OWNER}/abc.wav`, bytes);
    const names = await list(BUCKET, OWNER, { search: "abc" });
    assert.deepEqual(names, [{ name: "abc.wav" }]);
    assert.deepEqual(await readFile(BUCKET, `${OWNER}/abc.wav`), bytes);
  });

  it("a signed link serves the file while valid", async () => {
    await upload(BUCKET, `${OWNER}/served.wav`, Buffer.from("AUDIO"));
    const url = new URL(createSignedUrl(BUCKET, `${OWNER}/served.wav`, 60));
    const r = await call("GET", url.pathname + url.search);
    assert.equal(r.status, 200);
    assert.equal(r.body, "AUDIO");
  });

  it("a tampered token, a wrong path or an expired link is refused with 403", async () => {
    await upload(BUCKET, `${OWNER}/guard.wav`, Buffer.from("X"));
    const url = new URL(createSignedUrl(BUCKET, `${OWNER}/guard.wav`, 60));
    const bad = url.search.replace(/token=./, (m) => (m === "token=a" ? "token=b" : "token=a"));
    assert.equal((await call("GET", url.pathname + bad)).status, 403);
    const other = url.pathname.replace("guard.wav", "other.wav");
    assert.equal((await call("GET", other + url.search)).status, 403);
    const expired = new URL(createSignedUrl(BUCKET, `${OWNER}/guard.wav`, 60));
    expired.searchParams.set("expires", String(Math.floor(Date.now() / 1000) - 5));
    assert.equal((await call("GET", expired.pathname + expired.search)).status, 403);
  });

  it("path traversal is refused everywhere", async () => {
    await assert.rejects(upload(BUCKET, "../escape.wav", Buffer.from("x")));
    assert.throws(() => createSignedUrl(BUCKET, "../../etc/passwd", 60));
    assert.equal(verifySignedToken(BUCKET, "../x", "a", Math.floor(Date.now() / 1000) + 60), false);
  });
});

describe("Gemini text-to-speech helpers (no network)", () => {
  it("maps Sarvam voices to Gemini voices and passes through known Gemini voices", () => {
    assert.equal(resolveGeminiVoice("shubh"), "Charon");
    assert.equal(resolveGeminiVoice("Kore"), "Kore");
    assert.equal(resolveGeminiVoice("unknown-speaker"), "Charon");
  });

  it("writes a WAV that parses back to the same PCM and rate", () => {
    const pcm = new Uint8Array(4000).map((_, i) => (i % 2 ? 0 : 50));
    const wav = wrapWav(pcm, 24000);
    const parsed = parseWav(wav);
    assert.equal(parsed.sampleRate, 24000);
    assert.equal(parsed.pcm.length, pcm.length);
  });

  it("toCanonicalWav rejects non-audio and accepts raw L16 with a rate", () => {
    assert.equal(toCanonicalWav(new Uint8Array([1, 2, 3]), "text/plain"), null);
    const raw = new Uint8Array(2000).fill(7);
    const out = toCanonicalWav(raw, "audio/L16;rate=16000");
    assert.equal(parseWav(out).sampleRate, 16000);
  });

  it("extractAudio finds audio in model_output steps", () => {
    const payload = { steps: [{ type: "model_output", content: [{ type: "audio", data: "QUJD", mime_type: "audio/wav" }] }] };
    assert.deepEqual(extractAudio(payload), { data: "QUJD", mime: "audio/wav" });
    assert.equal(extractAudio({ steps: [] }), null);
  });

  it("style text names the language", () => {
    assert.match(styleFor("hi-IN"), /Hindi/);
  });
});
