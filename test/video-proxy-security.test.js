import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, base } from "./helpers.js";

const SERVICE = "svc-test-key-for-video-proxy-security";
let savedService;

const post = (body) =>
  fetch(`${base}/functions/v1/video-generation-proxy`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE}` },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

describe("video proxy: caller-chosen targets are restricted", () => {
  before(async () => {
    savedService = process.env.SERVICE_ROLE_KEY;
    process.env.SERVICE_ROLE_KEY = SERVICE;
    process.env.VIDEO_GEN_DEFAULT_SERVER_IP = "gpu.test.invalid";
    delete process.env.VIDEO_GEN_ALLOWED_PORTS;
    await startServer();
  });
  after(async () => {
    process.env.SERVICE_ROLE_KEY = savedService;
    await stopServer();
  });

  it("refuses a target_port that is not one of the GPU server's ports", async () => {
    const r = await post({ action: "status", job_id: "job-1", target_port: 8080 });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "server_ip or target_port not allowed");
  });

  it("accepts a listed port and reaches the upstream", async () => {
    const real = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url, opts) => {
      if (String(url).startsWith(base)) return real(url, opts);
      seen.push(String(url));
      return new Response(JSON.stringify({ state: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const r = await post({ action: "status", job_id: "job-1", target_port: 5005 });
      assert.equal(r.status, 200);
      assert.ok(seen.some((u) => u.includes(":5005/")), seen.join(", "));
    } finally {
      globalThis.fetch = real;
    }
  });

  it("refuses a full document URL whose host is not in VIDEO_GEN_DOCUMENT_HOSTS", async () => {
    const r = await post({ action: "submit", job_id: "job-doc", document_url: "http://169.254.169.254/latest/meta-data", story_hint: "x".repeat(20) });
    assert.notEqual(r.status, 200);
    assert.match(JSON.stringify(r.body), /document host not allowed|invalid|Failed to download/);
  });
});
