import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, base, post, q } from "./helpers.js";

// Actions ported in functions/video-generation-proxy/actions/a-submit.js.
// Every upstream call goes through a stub of globalThis.fetch. The app itself (base) is still reached for real.
const SERVICE = "test-video-a-service-key-not-real";
const GPU = "gpu.test.invalid"; // never resolved: the stub answers every upstream request
const PATH = "/functions/v1/video-generation-proxy";
const AUTH = { Authorization: `Bearer ${SERVICE}` };

const realFetch = globalThis.fetch;
let upstreamReply; // (url, init) => Response, or throws to simulate a network error
let upstreamCalls = [];
const subjectIds = [];

const proxy = (body, headers = AUTH) => post(PATH, body, headers);
const json = (status, data) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const upstreamCallsTo = (fragment) => upstreamCalls.filter((c) => c.url.includes(fragment));

const savedEnv = {};
const ENV_KEYS = ["SERVICE_ROLE_KEY", "VIDEO_GEN_DEFAULT_SERVER_IP", "VIDEO_GEN_ALLOWED_SERVER_IPS",
  "B2_KEY_ID", "B2_APPLICATION_KEY", "B2_BUCKET_NAME"];

describe("video-generation-proxy actions (a-submit)", () => {
  before(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.SERVICE_ROLE_KEY = SERVICE;
    process.env.VIDEO_GEN_DEFAULT_SERVER_IP = GPU;
    delete process.env.VIDEO_GEN_ALLOWED_SERVER_IPS;
    // No real B2 account: a missing document must fail before any B2 request is made.
    delete process.env.B2_KEY_ID;
    delete process.env.B2_APPLICATION_KEY;
    delete process.env.B2_BUCKET_NAME;

    await startServer();

    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith(base)) return realFetch(input, init);
      upstreamCalls.push({ url, init });
      if (!upstreamReply) throw new Error(`unexpected upstream call: ${url}`);
      return upstreamReply(url, init);
    };
  });

  after(async () => {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    if (subjectIds.length) await q("DELETE FROM public.popular_subjects WHERE id = ANY($1::uuid[])", [subjectIds]);
    await stopServer();
  });

  it("answers 401 for every ported action without an Authorization header", async () => {
    const bodies = [
      { action: "submit", markdown: "# Notes\nSome text" },
      { action: "generate_avatar", job_id: "job-auth-1" },
      { action: "retry_phase", job_id: "job-auth-1", phase: "tts_generation" },
      { action: "rerender", job_id: "job-auth-1", section_ids: [1] },
      { action: "regenerate_and_render", job_id: "job-auth-1", section_ids: [1] },
    ];
    for (const body of bodies) {
      const r = await proxy(body, {});
      assert.equal(r.status, 401, `${body.action} should be 401`);
    }
    assert.equal(upstreamCalls.length, 0);
  });

  it("answers 400 when job_id is missing for the job actions", async () => {
    const cases = [
      { action: "generate_avatar" },
      { action: "retry_phase", phase: "tts_generation" },
      { action: "rerender", section_ids: [1] },
      { action: "regenerate_and_render", section_ids: [1] },
    ];
    for (const body of cases) {
      const r = await proxy(body);
      assert.equal(r.status, 400, `${body.action} should be 400`);
      assert.equal(r.body.error, "job_id is required");
    }
    assert.equal(upstreamCalls.length, 0);
  });

  it("rejects invalid retry_phase input with 400", async () => {
    const missing = await proxy({ action: "retry_phase", job_id: "job-v-1" });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /^phase is required/);

    const bogus = await proxy({ action: "retry_phase", job_id: "job-v-1", phase: "bogus" });
    assert.equal(bogus.status, 400);
    assert.match(bogus.body.error, /^Invalid phase: bogus\./);
    assert.equal(upstreamCalls.length, 0);
  });

  it("rejects invalid rerender and regenerate_and_render input with 400", async () => {
    const empty = await proxy({ action: "rerender", job_id: "job-v-2", section_ids: [] });
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, "section_ids is required and must be a non-empty array");

    const notArray = await proxy({ action: "regenerate_and_render", job_id: "job-v-2", section_ids: 3 });
    assert.equal(notArray.status, 400);
    assert.equal(notArray.body.error, "section_ids is required and must be a non-empty array of integers");
    assert.equal(upstreamCalls.length, 0);
  });

  it("rejects invalid submit input with 400", async () => {
    const shortHint = await proxy({ action: "submit", reel_variant: "story", story_hint: "too short" });
    assert.equal(shortHint.status, 400);
    assert.match(shortHint.body.error, /^story_hint is required/);

    const nothing = await proxy({ action: "submit", subject: "Physics" });
    assert.equal(nothing.status, 400);
    assert.equal(nothing.body.error, "Either document_url or markdown content is required");
    assert.equal(upstreamCalls.length, 0);
  });

  it("submit forwards markdown to the target port as multipart form data", async () => {
    upstreamCalls = [];
    upstreamReply = () => json(200, { job_id: "j-sub-1", status: "queued" });

    const r = await proxy({
      action: "submit",
      target_port: 5005,
      subject: "Physics",
      markdown: "Newton laws of motion",
      avatar_id: "avatar_test_1",
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { job_id: "j-sub-1", status: "queued" });

    const [call] = upstreamCallsTo("/submit_job");
    assert.equal(call.url, `http://${GPU}:5005/submit_job`);
    assert.equal(call.init.method, "POST");
    const form = call.init.body;
    assert.ok(form instanceof FormData);
    assert.equal(form.get("subject"), "Physics");
    assert.equal(form.get("avatar_id"), "avatar_test_1");
    assert.equal(form.get("pipeline_version"), "v15_v2_director");
    assert.equal(await form.get("file").text(), "Newton laws of motion");
    assert.equal(form.get("file").name, "document.md");
  });

  it("submit resolves avatar_id from popular_subjects when avatar_id is omitted", async (t) => {
    const [existing] = await q("SELECT category_id FROM public.popular_subjects LIMIT 1");
    if (!existing) return t.skip("popular_subjects has no rows to take a category from");

    const stamp = Date.now();
    const name = `Video A Subject ${stamp}`;
    const [row] = await q(
      "INSERT INTO public.popular_subjects (name, slug, category_id, avatar_id) VALUES ($1, $2, $3, $4) RETURNING id",
      [name, `video-a-subject-${stamp}`, existing.category_id, "avatar_from_db"],
    );
    subjectIds.push(row.id);

    upstreamCalls = [];
    upstreamReply = () => json(200, { job_id: "j-sub-2" });
    const r = await proxy({ action: "submit", subject: name.toUpperCase(), markdown: "Chemistry notes" });
    assert.equal(r.status, 200);

    const [call] = upstreamCallsTo("/submit_job");
    assert.equal(call.init.body.get("avatar_id"), "avatar_from_db");
  });

  it("submit answers 500 when a document is missing and B2 is not configured", async () => {
    upstreamCalls = [];
    upstreamReply = () => json(200, {});
    const r = await proxy({ action: "submit", document_url: "missing-folder/not-here.pdf", file_name: "not-here.pdf" });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "B2 credentials not configured for document download");
    assert.equal(upstreamCallsTo("submit_job").length, 0);
  });

  it("retry_phase relays a valid request and reports the upstream acceptance", async () => {
    upstreamCalls = [];
    upstreamReply = () => json(200, { queued: true });

    const r = await proxy({
      action: "retry_phase",
      job_id: "job-rp-1",
      phase: "tts_generation",
      section_ids: [1, 2],
      user_feedback: "  louder narration  ",
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "accepted");
    assert.equal(r.body.message, "Phase 'tts_generation' regeneration confirmed by upstream");
    assert.deepEqual(r.body.upstream_response, { queued: true });
    assert.deepEqual(r.body.section_ids, [1, 2]);

    const [call] = upstreamCallsTo("/job/job-rp-1/retry_phase");
    assert.equal(call.url, `http://${GPU}:5006/job/job-rp-1/retry_phase`);
    assert.deepEqual(JSON.parse(call.init.body), {
      phase: "tts_generation",
      section_ids: [1, 2],
      user_feedback: "louder narration",
    });
  });

  it("retry_phase passes an upstream error status through", async () => {
    upstreamCalls = [];
    upstreamReply = () => json(409, { detail: "phase busy" });
    const r = await proxy({ action: "retry_phase", job_id: "job-rp-2", phase: "manim_render" });
    assert.equal(r.status, 409);
    assert.equal(r.body.status, "error");
    assert.equal(r.body.upstream_status, 409);
    assert.deepEqual(r.body.upstream_body, { detail: "phase busy" });
    assert.equal(r.body.section_ids, "all");
  });

  it("retry_phase answers 502 when the upstream cannot be reached", async () => {
    upstreamCalls = [];
    upstreamReply = () => {
      throw new TypeError("connect refused");
    };
    const r = await proxy({ action: "retry_phase", job_id: "job-rp-3", phase: "wan_render" });
    assert.equal(r.status, 502);
    assert.equal(r.body.error, "Failed to reach upstream: connect refused");
  });

  it("rerender relays section_ids and reports acceptance", async () => {
    upstreamCalls = [];
    upstreamReply = () => json(200, { started: true });
    const r = await proxy({ action: "rerender", job_id: "job-rr-1", section_ids: [3] });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "accepted");
    assert.equal(r.body.message, "Rerender started for 1 section(s)");
    assert.deepEqual(r.body.upstream_response, { started: true });

    const [call] = upstreamCallsTo("/jobs/job-rr-1/rerender");
    assert.deepEqual(JSON.parse(call.init.body), { section_ids: [3] });
  });

  it("rerender answers 200 with status error when upstream refuses", async () => {
    upstreamCalls = [];
    upstreamReply = () => json(500, { error: "render busy" });
    const r = await proxy({ action: "rerender", job_id: "job-rr-2", section_ids: [4] });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "error");
    assert.equal(r.body.error, "render busy");
    assert.equal(r.body.upstream_status, 500);
  });

  it("regenerate_and_render forwards the optional fields and reports acceptance", async () => {
    upstreamCalls = [];
    upstreamReply = () => json(200, { accepted: 1 });
    const r = await proxy({
      action: "regenerate_and_render",
      job_id: "job-rg-1",
      section_ids: [1, 5],
      renderers: ["manim"],
      execute: true,
      skip_wan: true,
      dry_run: false,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "accepted");
    assert.equal(r.body.message, "Regenerate and render started for 2 section(s)");

    const [call] = upstreamCallsTo("/jobs/job-rg-1/regenerate_and_render");
    assert.deepEqual(JSON.parse(call.init.body), {
      section_ids: [1, 5], renderers: ["manim"], execute: true, skip_wan: true, dry_run: false,
    });
  });

  it("generate_avatar relays the request and ignores a duplicate within the dedup window", async () => {
    upstreamCalls = [];
    upstreamReply = () => json(200, { status: "started" });
    const jobId = `job-ga-${Date.now()}`;

    const first = await proxy({ action: "generate_avatar", job_id: jobId });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { status: "started" });

    const second = await proxy({ action: "generate_avatar", job_id: jobId });
    assert.equal(second.status, 200);
    assert.equal(second.body.status, "duplicate_ignored");
    assert.equal(second.body.job_id, jobId);

    assert.equal(upstreamCallsTo(`/job/${jobId}/generate_avatar`).length, 1);
  });
});
