import "./helpers.js"; // loads .env and guards the test database
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import express from "express";
import jwt from "jsonwebtoken";
import { pool } from "../functions/_shared/db.js";
import { router } from "../functions/video-generation-proxy/index.js";

const SERVICE = "test-videogen-service-key-not-real";
let server;
let base;
let cdnStub;
let cdnPort;

const get = async (qs) => {
  const r = await fetch(`${base}/functions/v1/video-generation-proxy?${qs}`);
  return { status: r.status, headers: r.headers, text: await r.text() };
};
const post = async (body, token) => {
  const r = await fetch(`${base}/functions/v1/video-generation-proxy`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

describe("video-generation-proxy (partial port)", () => {
  before(async () => {
    process.env.SERVICE_ROLE_KEY = SERVICE;
    delete process.env.VIDEO_GEN_DEFAULT_SERVER_IP; // no GPU server is contacted from tests
    delete process.env.VIDEO_GEN_ALLOWED_SERVER_IPS;

    cdnStub = http.createServer((req, res) => {
      if (req.url === "/cdn-job/job1/clip.mp4") {
        res.writeHead(200, { "Content-Length": 9 });
        return res.end("cdn-video");
      }
      res.writeHead(404);
      return res.end();
    });
    cdnStub.listen(0, "127.0.0.1");
    await once(cdnStub, "listening");
    cdnPort = cdnStub.address().port;
    process.env.VIDEO_GEN_CDN_ALLOWED_HOSTS = `127.0.0.1:${cdnPort}`;

    const app = express();
    app.use(express.json());
    app.use("/functions/v1/video-generation-proxy", router);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    delete process.env.VIDEO_GEN_CDN_ALLOWED_HOSTS;
    await new Promise((r) => server.close(r));
    await new Promise((r) => cdnStub.close(r));
    await pool.end();
  });

  it("validates media requests and rejects path traversal", async () => {
    assert.equal((await get("action=media")).status, 400);
    const r = await get("action=media&job_id=job1&file_path=..%2Fsecret.mp4");
    assert.equal(r.status, 400);
    assert.deepEqual(JSON.parse(r.text), { error: "Invalid job_id or file_path" });
  });

  it("refuses a server_ip that is not on the allow list", async () => {
    const r = await get("action=media&job_id=job1&file_path=a.mp4&server_ip=10.1.1.1");
    assert.equal(r.status, 400);
    assert.deepEqual(JSON.parse(r.text), { error: "server_ip not allowed" });
  });

  it("only proxies CDN hosts on the allow list", async () => {
    const r = await get("action=cdn_proxy&job_id=job1&file_path=clip.mp4&cdn_base_url=" + encodeURIComponent("http://evil.example.test/x"));
    assert.equal(r.status, 400);
    assert.deepEqual(JSON.parse(r.text), { error: "cdn_base_url not allowed" });
  });

  it("streams a file from an allowed CDN host", async () => {
    const base2 = `http://127.0.0.1:${cdnPort}/cdn-job`;
    const r = await get(`action=cdn_proxy&job_id=job1&file_path=clip.mp4&cdn_base_url=${encodeURIComponent(base2)}`);
    assert.equal(r.status, 200);
    assert.equal(r.text, "cdn-video");
    assert.equal(r.headers.get("content-type"), "video/mp4");
  });

  it("requires a bearer token for POST actions", async () => {
    const r = await post({ action: "status", job_id: "job1" });
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: "Authorization required" });
  });

  it("rejects an invalid token", async () => {
    const r = await post({ action: "status", job_id: "job1" }, "garbage");
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, { error: "Invalid token" });
  });

  it("accepts a user JWT and the service key", async () => {
    const userJwt = jwt.sign({ sub: "00000000-0000-4000-8000-0000000000ce" }, process.env.JWT_SECRET, { expiresIn: 60 });
    const r = await post({ action: "status" }, userJwt);
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: "job_id is required" });
    const s = await post({ action: "status" }, SERVICE);
    assert.equal(s.status, 400);
  });

  it("validates dub_languages input", async () => {
    const r = await post({ action: "dub_languages", job_id: "job1", languages: [] }, SERVICE);
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: "languages must be a non-empty array" });
  });

  it("answers an action that does not exist with 501", async () => {
    const r = await post({ action: "no_such_action" }, SERVICE);
    assert.equal(r.status, 501);
    assert.equal(r.body.error, "not_ported");
    assert.equal(r.body.action, "no_such_action");
  });

  it("answers an unknown GET action with 400", async () => {
    const r = await get("action=nope");
    assert.equal(r.status, 400);
  });
});
