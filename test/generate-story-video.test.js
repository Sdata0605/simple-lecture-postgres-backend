import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser } from "./helpers.js";
import { serveRouter, hitAt } from "./route-harness.js";
import { router, hooks } from "../functions/generate-story-video/index.js";

describe("generate-story-video", () => {
  let r;
  let user;
  const savedKey = process.env.KIE_AI_API_KEY;
  const realFetch = hooks.fetch;
  const realSleep = hooks.sleep;
  before(async () => {
    await startServer();
    r = await serveRouter("/functions/v1/generate-story-video", router);
    user = await makeUser();
  });
  after(async () => {
    hooks.fetch = realFetch;
    hooks.sleep = realSleep;
    if (savedKey === undefined) delete process.env.KIE_AI_API_KEY;
    else process.env.KIE_AI_API_KEY = savedKey;
    await r.close();
    await stopServer();
  });
  const auth = () => ({ Authorization: `Bearer ${user.access}` });

  it("requires a Bearer token", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/generate-story-video", { body: { prompt: "x" } });
    assert.equal(res.status, 401);
  });

  it("rejects a request with neither storyText nor prompt", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/generate-story-video", { body: {}, headers: auth() });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "Story text or prompt is required" });
  });

  it("returns the placeholder when KIE_AI_API_KEY is missing", async () => {
    delete process.env.KIE_AI_API_KEY;
    const res = await hitAt(r.base, "POST", "/functions/v1/generate-story-video", { body: { prompt: "x" }, headers: auth() });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, false);
    assert.equal(res.body.videoUrl, null);
  });

  it("uses the direct URL when the primary endpoint returns one (stubbed)", async () => {
    process.env.KIE_AI_API_KEY = "test-key-not-real";
    const seen = [];
    hooks.fetch = async (url) => {
      seen.push(url);
      return new Response(JSON.stringify({ video_url: "https://cdn.example.test/v.mp4" }), { status: 200 });
    };
    const res = await hitAt(r.base, "POST", "/functions/v1/generate-story-video", { body: { storyText: "Photosynthesis" }, headers: auth() });
    assert.deepEqual(res.body, { success: true, videoUrl: "https://cdn.example.test/v.mp4" });
    assert.equal(seen.length, 1);
  });

  it("polls a task until it completes (stubbed, no waiting)", async () => {
    process.env.KIE_AI_API_KEY = "test-key-not-real";
    hooks.sleep = async () => {};
    let call = 0;
    hooks.fetch = async () => {
      call += 1;
      if (call === 1) return new Response(JSON.stringify({ task_id: "t1" }), { status: 200 });
      if (call === 2) return new Response(JSON.stringify({ status: "processing" }), { status: 200 });
      return new Response(JSON.stringify({ status: "completed", output: { url: "https://cdn.example.test/done.mp4" } }), { status: 200 });
    };
    const res = await hitAt(r.base, "POST", "/functions/v1/generate-story-video", { body: { prompt: "p" }, headers: auth() });
    assert.deepEqual(res.body, { success: true, videoUrl: "https://cdn.example.test/done.mp4" });
    assert.equal(call, 3);
  });
});
