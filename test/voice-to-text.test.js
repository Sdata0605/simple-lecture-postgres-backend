import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { pool } from "../functions/_shared/db.js";
import { router } from "../functions/voice-to-text/index.js";

let server;
let base;

describe("voice-to-text", () => {
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/functions/v1/voice-to-text", router);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    await pool.end();
  });

  it("returns the placeholder transcription", async () => {
    const r = await fetch(`${base}/functions/v1/voice-to-text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioBase64: "AAAA" }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { text: "What is the formula for kinetic energy?" });
  });
});
