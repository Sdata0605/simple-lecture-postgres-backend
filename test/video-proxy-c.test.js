import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, call, post } from "./helpers.js";

// Tests for functions/video-generation-proxy/actions/c-chatterbox.js.
// Every upstream call (Vimeo, Chatterbox, V2.5 on port 5005) goes through a stub. An unstubbed upstream call
// throws, so no test can reach a real server.

const PATH = "/functions/v1/video-generation-proxy";
const SERVICE = "test-videogen-service-key-not-real";
const AUTH = { Authorization: `Bearer ${SERVICE}` };
const TEST_SERVER_IP = "203.0.113.10"; // TEST-NET-3 documentation address, never contacted
const ENV_KEYS = ["SERVICE_ROLE_KEY", "VIDEO_GEN_DEFAULT_SERVER_IP", "VIDEO_GEN_ALLOWED_SERVER_IPS", "VIMEO_ACCESS_TOKEN", "VIDEO_GEN_CLOUD_SERVER_IP"];

const realFetch = globalThis.fetch;
const savedEnv = {};
let base;
let upstream = null; // (url, init) => Response; set per test
let upstreamCalls = [];

const jsonResponse = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

function setEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const act = (body, { auth = true } = {}) => post(PATH, body, auth ? AUTH : undefined);
const getAction = (params) => call("GET", `${PATH}?${new URLSearchParams(params)}`);

before(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.SERVICE_ROLE_KEY = SERVICE;
  setEnv("VIDEO_GEN_DEFAULT_SERVER_IP", TEST_SERVER_IP);
  setEnv("VIDEO_GEN_ALLOWED_SERVER_IPS", undefined);
  setEnv("VIMEO_ACCESS_TOKEN", undefined);
  setEnv("VIDEO_GEN_CLOUD_SERVER_IP", undefined);

  base = await startServer();
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(base)) return realFetch(input, init); // the test's own calls to the app
    upstreamCalls.push({ url, init });
    if (!upstream) throw new Error(`unexpected upstream fetch in test: ${url}`);
    return upstream(url, init);
  };
});

afterEach(() => {
  upstream = null;
  upstreamCalls = [];
});

after(async () => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) setEnv(k, savedEnv[k]);
  await stopServer();
});

describe("chatterbox_generate", () => {
  const full = { action: "chatterbox_generate", text: "Namaste", language: "hi", speaker: "Ravi" };

  it("returns 401 without Authorization", async () => {
    const r = await act(full, { auth: false });
    assert.equal(r.status, 401);
  });

  it("returns 400 naming every missing required field", async () => {
    const r = await act({ action: "chatterbox_generate", language: "hi" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "Missing required fields: text, speaker");
    assert.deepEqual(r.body.received, { text: false, language: "hi" });
  });

  it("returns 500 when no server is given and none is configured", async () => {
    setEnv("VIDEO_GEN_DEFAULT_SERVER_IP", undefined);
    try {
      const r = await act(full);
      assert.equal(r.status, 500);
      assert.equal(r.body.error, "VIDEO_GEN_DEFAULT_SERVER_IP not configured");
      assert.equal(upstreamCalls.length, 0);
    } finally {
      setEnv("VIDEO_GEN_DEFAULT_SERVER_IP", TEST_SERVER_IP);
    }
  });

  it("posts form data to the Chatterbox generate endpoint and returns the task id", async () => {
    upstream = () => jsonResponse({ task_id: "t1" });
    const r = await act(full);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { success: true, task_id: "t1" });
    assert.equal(upstreamCalls.length, 1);
    assert.equal(upstreamCalls[0].url, `http://${TEST_SERVER_IP}:5004/api/generate`);
    const form = upstreamCalls[0].init.body;
    assert.ok(form instanceof FormData);
    assert.equal(form.get("text"), "Namaste");
    assert.equal(form.get("speaker"), "Ravi");
  });

  it("passes through an upstream error status", async () => {
    upstream = () => new Response("bad voice", { status: 422 });
    const r = await act(full);
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "Chatterbox generate failed: bad voice");
    assert.equal(r.body.status, 422);
  });

  it("returns 503 retryable after three connection failures", async () => {
    upstream = () => {
      throw new TypeError("fetch failed");
    };
    const r = await act(full);
    assert.equal(r.status, 503);
    assert.equal(r.body.retryable, true);
    assert.equal(upstreamCalls.length, 3);
  });
});

describe("chatterbox_status", () => {
  it("returns 401 without Authorization", async () => {
    const r = await act({ action: "chatterbox_status", task_id: "abc" }, { auth: false });
    assert.equal(r.status, 401);
  });

  it("returns 400 when task_id is missing", async () => {
    const r = await act({ action: "chatterbox_status" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "task_id is required");
  });

  it("maps a 404 from Chatterbox to a terminal failed state with HTTP 200", async () => {
    upstream = () => new Response("nope", { status: 404 });
    const r = await act({ action: "chatterbox_status", task_id: "abc" });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "failed");
    assert.equal(r.body.terminal, true);
    assert.equal(upstreamCalls[0].url, `http://${TEST_SERVER_IP}:5004/api/status/abc`);
  });

  it("treats not_found inside a 200 body as terminal", async () => {
    upstream = () => jsonResponse({ status: "not_found" });
    const r = await act({ action: "chatterbox_status", task_id: "abc" });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "failed");
    assert.equal(r.body.terminal, true);
  });

  it("returns the upstream status body when the task is running", async () => {
    upstream = () => jsonResponse({ status: "processing", progress: 40 });
    const r = await act({ action: "chatterbox_status", task_id: "abc" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { status: "processing", progress: 40 });
  });
});

describe("chatterbox_library", () => {
  it("returns 500 when no server is configured", async () => {
    setEnv("VIDEO_GEN_DEFAULT_SERVER_IP", undefined);
    try {
      const r = await act({ action: "chatterbox_library" });
      assert.equal(r.status, 500);
      assert.equal(r.body.error, "VIDEO_GEN_DEFAULT_SERVER_IP not configured");
    } finally {
      setEnv("VIDEO_GEN_DEFAULT_SERVER_IP", TEST_SERVER_IP);
    }
  });

  it("returns the library list from the Chatterbox server", async () => {
    const library = { avatars: [{ id: "a1", name: "Ravi" }] };
    upstream = () => jsonResponse(library);
    const r = await act({ action: "chatterbox_library" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, library);
    assert.equal(upstreamCalls[0].url, `http://${TEST_SERVER_IP}:5004/api/library/list`);
  });

  it("passes through an upstream error status", async () => {
    upstream = () => new Response("down", { status: 502 });
    const r = await act({ action: "chatterbox_library" });
    assert.equal(r.status, 502);
    assert.equal(r.body.error, "Library fetch failed: down");
  });
});

describe("chatterbox_proxy (GET and POST)", () => {
  it("GET returns 400 when task_id is missing", async () => {
    const r = await getAction({ action: "chatterbox_proxy" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "task_id is required");
  });

  it("GET rejects a task_id with a path separator without calling upstream", async () => {
    const r = await getAction({ action: "chatterbox_proxy", task_id: "a/b" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "Invalid task_id");
    assert.equal(upstreamCalls.length, 0);
  });

  it("GET rejects a server_ip that is not allowed", async () => {
    const r = await getAction({ action: "chatterbox_proxy", task_id: "abc", server_ip: "198.51.100.7" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "server_ip not allowed");
  });

  it("GET streams the avatar, stripping a final_ prefix from task_id", async () => {
    upstream = () => new Response("MP4DATA", { status: 200 });
    const res = await fetch(`${base}${PATH}?action=chatterbox_proxy&task_id=final_abc`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "video/mp4");
    assert.equal(await res.text(), "MP4DATA");
    assert.equal(upstreamCalls[0].url, `http://${TEST_SERVER_IP}:5004/outputs/final_abc.mp4`);
  });

  it("POST returns 401 without Authorization", async () => {
    const r = await act({ action: "chatterbox_proxy", task_id: "abc" }, { auth: false });
    assert.equal(r.status, 401);
  });

  it("POST returns 400 when task_id is missing", async () => {
    const r = await act({ action: "chatterbox_proxy" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "task_id is required");
  });
});

describe("vimeo_proxy", () => {
  it("returns 400 when vimeo_id is missing", async () => {
    const r = await getAction({ action: "vimeo_proxy" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "vimeo_id is required");
  });

  it("without VIMEO_ACCESS_TOKEN, reports a 422 that names the missing token", async () => {
    setEnv("VIMEO_ACCESS_TOKEN", undefined);
    upstream = () => new Response("not found", { status: 404 });
    const r = await getAction({ action: "vimeo_proxy", vimeo_id: "123456" });
    assert.equal(r.status, 422);
    assert.match(r.body.error, /VIMEO_ACCESS_TOKEN/);
    assert.equal(r.body.debug.oembed_status, 404);
    assert.equal(r.body.debug.embed_status, 404);
    assert.equal(r.body.debug.config_status, 404);
    assert.ok(upstreamCalls.some((c) => c.url.startsWith("https://vimeo.com/api/oembed.json")));
    assert.ok(!upstreamCalls.some((c) => c.url.startsWith("https://api.vimeo.com/")));
  });
});

describe("multilang_generate_avatar", () => {
  it("returns 401 without Authorization", async () => {
    const r = await act({ action: "multilang_generate_avatar", job_id: "j1" }, { auth: false });
    assert.equal(r.status, 401);
  });

  it("returns 400 when job_id is missing", async () => {
    const r = await act({ action: "multilang_generate_avatar" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "job_id is required");
  });

  it("returns 500 when no server is configured", async () => {
    setEnv("VIDEO_GEN_DEFAULT_SERVER_IP", undefined);
    try {
      const r = await act({ action: "multilang_generate_avatar", job_id: "j1" });
      assert.equal(r.status, 500);
      assert.equal(r.body.error, "VIDEO_GEN_DEFAULT_SERVER_IP not configured");
    } finally {
      setEnv("VIDEO_GEN_DEFAULT_SERVER_IP", TEST_SERVER_IP);
    }
  });

  it("posts the default languages and speaker to the V2.5 API", async () => {
    upstream = () => jsonResponse({ status: "queued" });
    const r = await act({ action: "multilang_generate_avatar", job_id: "j1" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { status: "queued" });
    assert.equal(upstreamCalls[0].url, `http://${TEST_SERVER_IP}:5005/job/j1/generate_avatar`);
    assert.deepEqual(JSON.parse(upstreamCalls[0].init.body), { languages: ["hi"], speaker: "Sagar" });
  });

  it("passes through a V2.5 error status", async () => {
    upstream = () => new Response("busy", { status: 409 });
    const r = await act({ action: "multilang_generate_avatar", job_id: "j1" });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "V2.5 API error: busy");
  });
});

describe("multilang_avatar_status", () => {
  it("returns 400 when job_id is missing", async () => {
    const r = await act({ action: "multilang_avatar_status" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "job_id is required");
  });

  it("normalises a processing job into the progress shape", async () => {
    upstream = () => jsonResponse({ state: "Processing", sections_done: 1, sections_total: 4 });
    const r = await act({ action: "multilang_avatar_status", job_id: "j2" });
    assert.equal(r.status, 200);
    assert.equal(r.body.state, "processing");
    assert.equal(r.body.status, "processing");
    assert.equal(r.body.completed, 1);
    assert.equal(r.body.total, 4);
    assert.equal(r.body.progress, "1/4");
    assert.equal(upstreamCalls[0].url, `http://${TEST_SERVER_IP}:5005/job/j2/avatar_status`);
  });

  it("reports a non-cloud 404 as not_found but not terminal", async () => {
    upstream = () => new Response("missing", { status: 404 });
    const r = await act({ action: "multilang_avatar_status", job_id: "j2" });
    assert.equal(r.status, 404);
    assert.equal(r.body.state, "not_found");
    assert.equal(r.body.terminal, false);
    assert.equal(r.body.server_path, "normal");
  });
});

describe("save_language_avatar_to_cdn", () => {
  const full = { action: "save_language_avatar_to_cdn", task_id: "t1", external_job_id: "job1", section_id: 2, language: "hi" };

  it("returns 401 without Authorization", async () => {
    const r = await act(full, { auth: false });
    assert.equal(r.status, 401);
  });

  it("returns 400 when a required field is missing", async () => {
    const { language, ...partial } = full;
    const r = await act(partial);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "task_id, external_job_id, section_id, and language are required");
  });

  it("returns 400 for a job id that would escape the output folder", async () => {
    const r = await act({ ...full, external_job_id: "../etc" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "external_job_id, section_id, or language is invalid");
    assert.equal(upstreamCalls.length, 0);
  });

  it("returns 400 for a language with path characters", async () => {
    const r = await act({ ...full, language: "hi/../x" });
    assert.equal(r.status, 400);
  });

  it("returns 500 with success false when the Chatterbox download fails", async () => {
    upstream = () => new Response("missing", { status: 404 });
    const r = await act(full);
    assert.equal(r.status, 500);
    assert.equal(r.body.success, false);
    assert.equal(r.body.error, "Chatterbox responded with 404");
    assert.equal(upstreamCalls[0].url, `http://${TEST_SERVER_IP}:5004/outputs/final_t1.mp4`);
  });
});
