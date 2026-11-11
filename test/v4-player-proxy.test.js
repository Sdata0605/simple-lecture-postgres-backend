import "./helpers.js"; // loads .env and guards the test database
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import express from "express";
import { pool } from "../functions/_shared/db.js";
import { router, boundRange } from "../functions/v4-player-proxy/index.js";

// A local stand-in for a v4 player origin. Nothing outside 127.0.0.1 is contacted.
let stub;
let stubPort;
let server;
let base;

const ENV_KEYS = ["V4_PLAYER_ORIGIN_IP", "V4_PLAYER_ORIGIN_PORT", "V4_PLAYER_ALLOWED_ORIGINS", "V4_PLAYER_CDN_ORIGIN"];

const get = async (p, headers = {}) => {
  const r = await fetch(base + p, { headers });
  return { status: r.status, headers: r.headers, text: await r.text() };
};

describe("v4-player-proxy", () => {
  before(async () => {
    stub = http.createServer((req, res) => {
      if (req.url.startsWith("/player/index.html")) {
        res.writeHead(200, { "Content-Length": 5 });
        return res.end("v4-ok");
      }
      res.writeHead(200, { "Content-Length": 2 });
      return res.end("ok");
    });
    stub.listen(0, "127.0.0.1");
    await once(stub, "listening");
    stubPort = stub.address().port;

    const app = express();
    app.use("/functions/v1/v4-player-proxy", router);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}/functions/v1/v4-player-proxy`;
  });

  after(async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    await new Promise((r) => server.close(r));
    await new Promise((r) => stub.close(r));
    await pool.end();
  });

  it("caps an open-ended media range to one chunk", () => {
    assert.equal(boundRange("bytes=0-", "/x/a.mp4"), "bytes=0-1048575");
    assert.equal(boundRange("bytes=100-", "/x/a.mp4"), "bytes=100-1048675");
    assert.equal(boundRange("bytes=0-", "/x/a.html"), "bytes=0-");
    assert.equal(boundRange("bytes=0-99", "/x/a.mp4"), "bytes=0-99");
  });

  it("reports 503 when no default origin is configured", async () => {
    delete process.env.V4_PLAYER_ORIGIN_IP;
    const r = await get("/player/index.html");
    assert.equal(r.status, 503);
  });

  it("refuses an origin override that is not on the allow list", async () => {
    process.env.V4_PLAYER_ALLOWED_ORIGINS = "127.0.0.1:1";
    const r = await get("/player/index.html?__ip=10.9.8.7&__port=5006");
    assert.equal(r.status, 400);
    assert.deepEqual(JSON.parse(r.text), { error: "Origin not allowed" });
  });

  it("proxies to an allowed override origin", async () => {
    process.env.V4_PLAYER_ALLOWED_ORIGINS = `127.0.0.1:${stubPort}`;
    const r = await get(`/player/index.html?__ip=127.0.0.1&__port=${stubPort}`);
    assert.equal(r.status, 200);
    assert.equal(r.text, "v4-ok");
  });

  it("uses the configured default origin and reports the bounded range upstream", async () => {
    process.env.V4_PLAYER_ORIGIN_IP = "127.0.0.1";
    process.env.V4_PLAYER_ORIGIN_PORT = String(stubPort);
    const r = await get("/player/index.html", {});
    assert.equal(r.text, "v4-ok");
    const m = await get("/player/clip.mp4", { Range: "bytes=0-" });
    assert.equal(m.headers.get("x-v4-requested-range"), "bytes=0-");
    assert.equal(m.headers.get("x-v4-upstream-range"), "bytes=0-1048575");
  });
});
