import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { pool } from "../functions/_shared/db.js";
import { router } from "../functions/transfer-recording/index.js";

const SERVICE = "test-transfer-service-key-not-real";
let server;
let base;
const post = async (body, auth) => {
  const r = await fetch(`${base}/functions/v1/transfer-recording`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

describe("transfer-recording", () => {
  before(async () => {
    process.env.SERVICE_ROLE_KEY = SERVICE;
    delete process.env.B2_APPLICATION_KEY_ID; // the transfer stops before any B2 call
    delete process.env.B2_APPLICATION_KEY;
    delete process.env.B2_BUCKET_ID;
    const app = express();
    app.use(express.json());
    app.use("/functions/v1/transfer-recording", router);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    await pool.end();
  });

  it("refuses callers without the service key or an admin token", async () => {
    const r = await post({ recording_id: "00000000-0000-4000-8000-0000000000dd" });
    assert.equal(r.status, 401);
  });

  it("requires recording_id", async () => {
    const r = await post({}, SERVICE);
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: "recording_id is required" });
  });

  it("stops with an error when B2 is not configured", async () => {
    const r = await post({ recording_id: "00000000-0000-4000-8000-0000000000dd" }, SERVICE);
    assert.equal(r.status, 500);
    assert.equal(typeof r.body.error, "string");
    assert.doesNotMatch(r.body.error, /key/i);
  });
});
