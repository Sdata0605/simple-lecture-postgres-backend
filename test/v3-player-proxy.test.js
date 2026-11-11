import "./helpers.js"; // loads .env and guards the test database
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import express from "express";
import { pool } from "../functions/_shared/db.js";
import { router } from "../functions/v3-player-proxy/index.js";

// A local stand-in for the player origin and the CDN, so the proxy never reaches a real host.
let stub;
let stubBase;
let server;
let base;

function startStub() {
  return http.createServer((req, res) => {
    if (req.url === "/player/index.html") {
      res.writeHead(200, { "Content-Length": 8 });
      return res.end("hello-v3");
    }
    if (req.url === "/player/clip.mp4" && req.headers.range) {
      res.writeHead(206, { "Content-Range": "bytes 0-6/100", "Content-Length": 7, "Accept-Ranges": "bytes" });
      return res.end("partial");
    }
    if (req.url === "/cdn/job1/file.mp4") {
      res.writeHead(200, { "Content-Length": 9 });
      return res.end("cdn-bytes");
    }
    res.writeHead(404);
    return res.end("missing");
  });
}

const get = async (p, headers = {}) => {
  const r = await fetch(base + p, { headers });
  return { status: r.status, headers: r.headers, text: await r.text() };
};

describe("v3-player-proxy", () => {
  before(async () => {
    stub = startStub();
    stub.listen(0, "127.0.0.1");
    await once(stub, "listening");
    stubBase = `http://127.0.0.1:${stub.address().port}`;
    process.env.V3_PLAYER_ORIGIN = stubBase;
    process.env.V3_PLAYER_CDN_ORIGIN = `${stubBase}/cdn`;

    const app = express();
    app.use("/functions/v1/v3-player-proxy", router);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}/functions/v1/v3-player-proxy`;
  });

  after(async () => {
    delete process.env.V3_PLAYER_ORIGIN;
    delete process.env.V3_PLAYER_CDN_ORIGIN;
    await new Promise((r) => server.close(r));
    await new Promise((r) => stub.close(r));
    await pool.end();
  });

  it("proxies a player file with its content type", async () => {
    const r = await get("/player/index.html");
    assert.equal(r.status, 200);
    assert.equal(r.text, "hello-v3");
    assert.match(r.headers.get("content-type"), /^text\/html/);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
  });

  it("falls back to the CDN for a missing job file", async () => {
    const r = await get("/player/jobs/job1/file.mp4");
    assert.equal(r.status, 200);
    assert.equal(r.text, "cdn-bytes");
    assert.equal(r.headers.get("content-type"), "video/mp4");
  });

  it("forwards range requests and the partial status", async () => {
    const r = await get("/player/clip.mp4", { Range: "bytes=0-6" });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get("content-range"), "bytes 0-6/100");
    assert.equal(r.text, "partial");
  });

  it("reports 503 when no origin is configured", async () => {
    const saved = process.env.V3_PLAYER_ORIGIN;
    delete process.env.V3_PLAYER_ORIGIN;
    try {
      const r = await get("/player/index.html");
      assert.equal(r.status, 503);
    } finally {
      process.env.V3_PLAYER_ORIGIN = saved;
    }
  });
});
