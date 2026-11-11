import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { pool } from "../functions/_shared/db.js";
import { router } from "../functions/vimeo-resolve/index.js";

let server;
let base;
const call = async (path, body) => {
  const r = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};

describe("vimeo-resolve", () => {
  before(async () => {
    delete process.env.VIMEO_ACCESS_TOKEN; // without a token no call to Vimeo can be made
    const app = express();
    app.use(express.json());
    app.use("/functions/v1/vimeo-resolve", router);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    await pool.end();
  });

  it("requires an id", async () => {
    const r = await call("/functions/v1/vimeo-resolve");
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: "missing id" });
  });

  it("extracts the id from a POSTed Vimeo URL, then reports the missing token", async () => {
    const r = await call("/functions/v1/vimeo-resolve", { vimeo_url: "https://vimeo.com/123456789" });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "VIMEO_ACCESS_TOKEN not set");
  });

  it("reports a missing token for a GET id", async () => {
    const r = await call("/functions/v1/vimeo-resolve?id=42");
    assert.equal(r.status, 500);
  });
});
