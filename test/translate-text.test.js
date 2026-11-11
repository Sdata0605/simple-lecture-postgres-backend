import "./helpers.js"; // loads .env and guards the test database
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import jwt from "jsonwebtoken";
import { pool } from "../functions/_shared/db.js";
import { router } from "../functions/translate-text/index.js";

let server;
let base;
const userToken = () => jwt.sign({ sub: "00000000-0000-4000-8000-0000000000aa", role: "authenticated" }, process.env.JWT_SECRET, { expiresIn: 60 });
const post = async (body, token) => {
  const r = await fetch(`${base}/functions/v1/translate-text`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

describe("translate-text", () => {
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/functions/v1/translate-text", router);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    await pool.end();
  });

  it("requires a signed-in user", async () => {
    const r = await post({ text: "hi", targetLanguage: "hi-IN" });
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: "Unauthorized" });
  });

  it("validates text and targetLanguage", async () => {
    assert.deepEqual((await post({ targetLanguage: "hi-IN" }, userToken())).body, { error: "text is required" });
    assert.deepEqual((await post({ text: "hi" }, userToken())).body, { error: "targetLanguage is required" });
  });

  it("returns English text unchanged", async () => {
    const r = await post({ text: "Hello", targetLanguage: "en-IN" }, userToken());
    assert.deepEqual(r.body, { translatedText: "Hello", sourceLanguage: "en-IN", targetLanguage: "en-IN" });
  });

  it("rejects an unsupported language", async () => {
    const r = await post({ text: "Hello", targetLanguage: "xx-XX" }, userToken());
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: "Unsupported language: xx-XX" });
  });
});
