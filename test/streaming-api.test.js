import "./helpers.js"; // loads .env and guards the test database
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import jwt from "jsonwebtoken";
import { pool } from "../functions/_shared/db.js";
import { router } from "../functions/streaming-api/index.js";

let server;
let base;
const token = () => jwt.sign({ sub: "00000000-0000-4000-8000-0000000000bb", role: "authenticated" }, process.env.JWT_SECRET, { expiresIn: 60 });
const act = async (body, auth = true) => {
  const r = await fetch(`${base}/functions/v1/streaming-api`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${token()}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

describe("streaming-api", () => {
  before(async () => {
    delete process.env.B2_KEY_ID; // no B2 call can be made from tests
    delete process.env.B2_APPLICATION_KEY;
    const app = express();
    app.use(express.json());
    app.use("/functions/v1/streaming-api", router);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    // report-quality writes one log row; remove the rows this test created (no recording, no user).
    await pool.query("DELETE FROM public.network_quality_logs WHERE recording_id IS NULL AND user_id IS NULL AND connection_type = 'wifi' AND latency_ms = 40");
    await new Promise((r) => server.close(r));
    await pool.end();
  });

  it("requires a signed-in user", async () => {
    const r = await act({ action: "test-cloudflare" }, false);
    assert.equal(r.status, 401);
  });

  it("answers unknown actions with 400", async () => {
    const r = await act({ action: "nope" });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: "Unknown action" });
  });

  it("reports a missing recording as an error", async () => {
    const r = await act({ action: "get-playback-url", recording_id: "00000000-0000-4000-8000-0000000000cc" });
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: "Recording not found" });
  });

  it("recommends a quality from the reported bandwidth", async () => {
    const r = await act({ action: "report-quality", recording_id: null, user_id: null, metrics: { bandwidth: 3, latency: 40, connectionType: "wifi" } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { recommendedQuality: "720p" });
  });

  it("lists ready recordings", async () => {
    const r = await act({ action: "list-recordings", limit: 5 });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.recordings));
  });

  it("answers the Cloudflare placeholder", async () => {
    const r = await act({ action: "test-cloudflare" });
    assert.deepEqual(r.body, { success: true });
  });
});
