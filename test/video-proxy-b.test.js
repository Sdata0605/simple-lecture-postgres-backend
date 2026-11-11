import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, base, call } from "./helpers.js";

// Upstream GPU server is a non-routable address. Every upstream call is stubbed below, so nothing leaves the process.
const UPSTREAM = "http://10.255.255.1:5006";
const SERVICE = "test-videogen-b-service-key-not-real";
const AUTH = { Authorization: `Bearer ${SERVICE}` };
const PATH = "/functions/v1/video-generation-proxy";

const realFetch = globalThis.fetch;
let routes = [];
let calls = [];

const json = (status, data) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const text = (status, body) => new Response(body, { status });

// Replaces fetch for upstream URLs only. Requests to the local test server pass through.
// An upstream URL with no matching route throws, so an unexpected call fails the test.
function installStub() {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(base)) return realFetch(input, init);
    const method = (init.method || "GET").toUpperCase();
    let sent;
    try {
      sent = init.body ? JSON.parse(init.body) : undefined;
    } catch {
      sent = init.body;
    }
    calls.push({ url, method, body: sent });
    const route = routes.find((r) => r.method === method && url.includes(r.match));
    if (!route) throw new Error(`unstubbed upstream call: ${method} ${url}`);
    return route.respond(url, sent);
  };
}

// Sets the stub routes for one test and clears the recorded calls.
function useRoutes(list) {
  routes = list;
  calls = [];
}

const act = (body, { auth = true } = {}) => call("POST", PATH, { body, headers: auth ? AUTH : {} });
const callsTo = (fragment) => calls.filter((c) => c.url.includes(fragment));

describe("video-generation-proxy B-actions (review, sanity, repair, status)", () => {
  const savedEnv = {};
  const setEnv = (k, v) => {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  };

  before(async () => {
    setEnv("SERVICE_ROLE_KEY", SERVICE);
    setEnv("VIDEO_GEN_DEFAULT_SERVER_IP", "10.255.255.1");
    delete process.env.VIDEO_GEN_ALLOWED_SERVER_IPS;
    await startServer();
    installStub();
  });

  after(async () => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await stopServer();
  });

  describe("review (public)", () => {
    it("400 without job_id, even with no Authorization header", async () => {
      const r = await act({ action: "review" }, { auth: false });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "job_id is required");
    });

    it("returns presentation.json from the GPU server", async () => {
      useRoutes([{ method: "GET", match: `${UPSTREAM}/player/jobs/job_rv1/presentation.json`, respond: () => json(200, { presentation_title: "Hi", sections: [] }) }]);
      const r = await act({ action: "review", job_id: "job_rv1" }, { auth: false });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { presentation_title: "Hi", sections: [] });
    });

    it("falls back to the CDN copy when the GPU server lacks the file", async () => {
      useRoutes([
        { method: "GET", match: `${UPSTREAM}/player/jobs/job_rv2/presentation.json`, respond: () => text(404, "missing") },
        { method: "GET", match: "https://server1.simplelecture.com/video/job_rv2/presentation.json", respond: () => json(200, { from: "cdn" }) },
      ]);
      const r = await act({ action: "review", job_id: "job_rv2" }, { auth: false });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { from: "cdn" });
    });

    it("passes the upstream status through when the CDN copy is also missing", async () => {
      useRoutes([
        { method: "GET", match: `${UPSTREAM}/player/jobs/job_rv3/presentation.json`, respond: () => text(404, "gone") },
        { method: "GET", match: "https://server1.simplelecture.com/video/job_rv3/presentation.json", respond: () => text(404, "") },
      ]);
      const r = await act({ action: "review", job_id: "job_rv3" }, { auth: false });
      assert.equal(r.status, 404);
      assert.equal(r.body.error, "Upstream error: gone");
      assert.equal(r.body.status, 404);
    });

    it("returns 200 with an unreachable message when the GPU server cannot be contacted", async () => {
      useRoutes([]);
      const r = await act({ action: "review", job_id: "job_rv4" }, { auth: false });
      assert.equal(r.status, 200);
      assert.match(r.body.error, /Server unreachable/);
    });
  });

  describe("submit_review", () => {
    it("401 without Authorization", async () => {
      const r = await act({ action: "submit_review", job_id: "j", sections: [] }, { auth: false });
      assert.equal(r.status, 401);
    });

    it("400 without job_id", async () => {
      const r = await act({ action: "submit_review", sections: [{ section_id: 1, notes: "x" }] });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "job_id is required");
    });

    it("400 when sections is not an array", async () => {
      const r = await act({ action: "submit_review", job_id: "j", sections: "nope" });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "sections array is required");
    });

    it("400 when no section carries usable notes", async () => {
      const r = await act({ action: "submit_review", job_id: "j", sections: [{ section_id: 1, notes: "   " }, { notes: "x" }] });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "No edits to submit");
    });

    it("posts only valid edits to the job-scoped route", async () => {
      useRoutes([{ method: "POST", match: `${UPSTREAM}/job/job_sr1/submit_review`, respond: () => json(200, { saved: true }) }]);
      const r = await act({
        action: "submit_review",
        job_id: "job_sr1",
        sections: [{ section_id: 2, notes: "Shorter intro" }, { section_id: 3, notes: "" }],
      });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { saved: true });
      const sent = callsTo("/submit_review")[0].body;
      assert.equal(sent.job_id, "job_sr1");
      assert.equal(sent.edits.length, 1);
      assert.equal(sent.edits[0].section_id, 2);
      assert.equal(sent.edits[0].feedback, "Shorter intro");
    });

    it("retries the global /submit_review route when the job-scoped route returns 404", async () => {
      useRoutes([
        { method: "POST", match: `${UPSTREAM}/job/job_sr2/submit_review`, respond: () => text(404, "not found") },
        { method: "POST", match: `${UPSTREAM}/submit_review`, respond: () => json(201, { saved: "global" }) },
      ]);
      const r = await act({ action: "submit_review", job_id: "job_sr2", sections: [{ section_id: 1, notes: "fix" }] });
      assert.equal(r.status, 201);
      assert.deepEqual(r.body, { saved: "global" });
      assert.equal(callsTo("/submit_review").length, 2);
    });
  });

  describe("regenerate_with_feedback", () => {
    it("401 without Authorization", async () => {
      const r = await act({ action: "regenerate_with_feedback", job_id: "j", section_id: 1 }, { auth: false });
      assert.equal(r.status, 401);
    });

    it("400 without job_id", async () => {
      const r = await act({ action: "regenerate_with_feedback", section_id: 1 });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "job_id is required");
    });

    it("400 without section_id", async () => {
      const r = await act({ action: "regenerate_with_feedback", job_id: "j" });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "section_id is required");
    });

    it("calls retry_phase with the default phase and wraps the reply", async () => {
      useRoutes([{ method: "POST", match: `${UPSTREAM}/job/job_rf1/retry_phase`, respond: () => json(200, { queued: true }) }]);
      const r = await act({ action: "regenerate_with_feedback", job_id: "job_rf1", section_id: 3, feedback: "brighter" });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { success: true, section_id: 3, phase: "avatar_generation", queued: true });
      assert.deepEqual(callsTo("/retry_phase")[0].body, { phase: "avatar_generation", section_ids: [3], user_feedback: "brighter" });
    });
  });

  describe("recreate_from_review", () => {
    it("401 without Authorization", async () => {
      const r = await act({ action: "recreate_from_review", job_id: "j" }, { auth: false });
      assert.equal(r.status, 401);
    });

    it("400 without job_id", async () => {
      const r = await act({ action: "recreate_from_review" });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "job_id is required");
    });

    it("forwards section_ids and edits to recreate_job_from_review", async () => {
      useRoutes([{ method: "POST", match: `${UPSTREAM}/recreate_job_from_review`, respond: () => json(202, { accepted: true }) }]);
      const r = await act({ action: "recreate_from_review", job_id: "job_rr1", section_ids: [1, 2], edits: [{ section_id: 1 }] });
      assert.equal(r.status, 202);
      assert.deepEqual(r.body, { accepted: true });
      assert.deepEqual(callsTo("/recreate_job_from_review")[0].body, { job_id: "job_rr1", section_ids: [1, 2], edits: [{ section_id: 1 }] });
    });
  });

  describe("sanity_check", () => {
    it("401 without Authorization", async () => {
      const r = await act({ action: "sanity_check", job_id: "j" }, { auth: false });
      assert.equal(r.status, 401);
    });

    it("400 without job_id", async () => {
      const r = await act({ action: "sanity_check" });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "job_id is required");
    });

    it("passes through the upstream status when presentation.json is unavailable", async () => {
      useRoutes([{ method: "GET", match: `${UPSTREAM}/player/jobs/job_sc0/presentation.json`, respond: () => text(404, "") }]);
      const r = await act({ action: "sanity_check", job_id: "job_sc0" });
      assert.equal(r.status, 404);
      assert.equal(r.body.error, "Failed to fetch presentation data");
    });

    it("builds the per-section report and summary", async () => {
      const presentation = {
        presentation_title: "Cells",
        sections: [
          { section_id: 1, section_type: "intro", title: "Intro" },
          {
            section_id: 2,
            section_type: "content",
            title: "Body",
            renderer: "MANIM",
            avatar_video: "avatars/s2.mp4",
            video_path: "videos/s2.mp4",
            visual_beats: [{ image_id: "img_a.jpg", beat_id: "b1" }],
            video_prompts: [{}],
            narration: { segments: [{}] },
            manim_specs: [{}],
          },
        ],
      };
      // Every HEAD succeeds except the image, which is missing.
      const headOk = (url) => text(url.includes("images/") ? 404 : 200, null);
      useRoutes([
        { method: "GET", match: `${UPSTREAM}/player/jobs/job_sc1/presentation.json`, respond: () => json(200, presentation) },
        { method: "HEAD", match: `${UPSTREAM}/player/jobs/job_sc1/`, respond: headOk },
      ]);
      const r = await act({ action: "sanity_check", job_id: "job_sc1" });
      assert.equal(r.status, 200);
      assert.equal(r.body.check_status, "complete");
      assert.equal(r.body.presentation_title, "Cells");
      assert.equal(r.body.orphans_found, false);
      assert.equal(r.body.sections.length, 2);

      const content = r.body.sections[1];
      assert.equal(content.avatar_video.status, 200);
      assert.equal(content.topic_video.path, "videos/s2.mp4");
      assert.equal(content.topic_video.status, 200);
      assert.equal(content.images[0].image_id, "img_a.jpg");
      assert.equal(content.images[0].status, 404);
      assert.equal(content.prompts_vs_disk.status, "MATCH");
      assert.equal(content.v25_logic_check.type, "Manim V2.6");
      assert.equal(content.v25_logic_check.status, "PASS");
      assert.equal(content.url_health.clean, true);

      assert.equal(r.body.summary.total_sections, 2);
      assert.equal(r.body.summary.avatar_total, 2);
      assert.equal(r.body.summary.images_total, 1);
      assert.equal(r.body.summary.images_healthy, 0);
      assert.equal(r.body.summary.v25_pass, 1);
      assert.equal(r.body.summary.v25_fail, 0);
    });
  });

  describe("repair_urls", () => {
    it("401 without Authorization", async () => {
      const r = await act({ action: "repair_urls", job_id: "j" }, { auth: false });
      assert.equal(r.status, 401);
    });

    it("400 without job_id", async () => {
      const r = await act({ action: "repair_urls" });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "job_id is required");
    });

    it("returns success with the upstream payload", async () => {
      useRoutes([{ method: "POST", match: `${UPSTREAM}/api/repair-urls/job_ru1`, respond: () => json(200, { fixed: 2 }) }]);
      const r = await act({ action: "repair_urls", job_id: "job_ru1" });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { success: true, fixed: 2 });
    });

    it("passes the upstream failure status through", async () => {
      useRoutes([{ method: "POST", match: `${UPSTREAM}/api/repair-urls/job_ru2`, respond: () => text(500, "broken") }]);
      const r = await act({ action: "repair_urls", job_id: "job_ru2" });
      assert.equal(r.status, 500);
      assert.equal(r.body.error, "URL repair failed: broken");
    });
  });

  describe("repair_missing_assets", () => {
    it("401 without Authorization", async () => {
      const r = await act({ action: "repair_missing_assets", job_id: "j" }, { auth: false });
      assert.equal(r.status, 401);
    });

    it("400 without job_id", async () => {
      const r = await act({ action: "repair_missing_assets" });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "job_id is required");
    });

    it("reports upstream failure as 200 with status error and the parsed message", async () => {
      useRoutes([{ method: "POST", match: `${UPSTREAM}/api/repair-missing-assets/job_rm1`, respond: () => json(500, { error: "disk full" }) }]);
      const r = await act({ action: "repair_missing_assets", job_id: "job_rm1" });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { status: "error", error: "disk full", upstream_status: 500 });
    });

    it("returns the upstream payload on success", async () => {
      useRoutes([{ method: "POST", match: `${UPSTREAM}/api/repair-missing-assets/job_rm2`, respond: () => json(200, { repaired: 4 }) }]);
      const r = await act({ action: "repair_missing_assets", job_id: "job_rm2" });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { repaired: 4 });
    });
  });

  describe("stitch_assets", () => {
    it("401 without Authorization", async () => {
      const r = await act({ action: "stitch_assets", job_id: "j" }, { auth: false });
      assert.equal(r.status, 401);
    });

    it("400 without job_id", async () => {
      const r = await act({ action: "stitch_assets" });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "job_id is required");
    });

    it("returns the upstream payload on success", async () => {
      useRoutes([{ method: "POST", match: `${UPSTREAM}/api/repair-metadata/job_st1`, respond: () => json(200, { stitched: true }) }]);
      const r = await act({ action: "stitch_assets", job_id: "job_st1" });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { stitched: true });
    });

    it("passes the upstream failure status through", async () => {
      useRoutes([{ method: "POST", match: `${UPSTREAM}/api/repair-metadata/job_st2`, respond: () => text(422, "bad") }]);
      const r = await act({ action: "stitch_assets", job_id: "job_st2" });
      assert.equal(r.status, 422);
      assert.equal(r.body.error, "Asset stitch failed: bad");
      assert.equal(r.body.status, 422);
    });
  });

  describe("avatar_regen_status", () => {
    it("401 without Authorization", async () => {
      const r = await act({ action: "avatar_regen_status", job_id: "j" }, { auth: false });
      assert.equal(r.status, 401);
    });

    it("400 without job_id", async () => {
      const r = await act({ action: "avatar_regen_status" });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "job_id is required");
    });

    it("maps a 404 from the GPU server to state idle", async () => {
      useRoutes([{ method: "GET", match: `${UPSTREAM}/job/job_ar1/avatar_status`, respond: () => text(404, "") }]);
      const r = await act({ action: "avatar_regen_status", job_id: "job_ar1" });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { state: "idle", message: "No active avatar regeneration task", details: null });
    });

    it("returns the upstream status document", async () => {
      useRoutes([{ method: "GET", match: `${UPSTREAM}/job/job_ar2/avatar_status`, respond: () => json(200, { state: "running", done: 3 }) }]);
      const r = await act({ action: "avatar_regen_status", job_id: "job_ar2" });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { state: "running", done: 3 });
    });
  });

  describe("regen_job_status", () => {
    it("401 without Authorization", async () => {
      const r = await act({ action: "regen_job_status", job_id: "j" }, { auth: false });
      assert.equal(r.status, 401);
    });

    it("400 without job_id", async () => {
      const r = await act({ action: "regen_job_status" });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "job_id is required");
    });

    it("returns the job status on success", async () => {
      useRoutes([{ method: "GET", match: `${UPSTREAM}/job/job_rs1/status`, respond: () => json(200, { status: "completed" }) }]);
      const r = await act({ action: "regen_job_status", job_id: "job_rs1" });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { status: "completed" });
    });

    it("passes the upstream failure status through with status error", async () => {
      useRoutes([{ method: "GET", match: `${UPSTREAM}/job/job_rs2/status`, respond: () => text(404, "no job") }]);
      const r = await act({ action: "regen_job_status", job_id: "job_rs2" });
      assert.equal(r.status, 404);
      assert.equal(r.body.status, "error");
      assert.equal(r.body.status_message, "Failed to fetch status: no job");
    });
  });

  describe("analytics", () => {
    it("401 without Authorization", async () => {
      const r = await act({ action: "analytics", job_id: "j" }, { auth: false });
      assert.equal(r.status, 401);
    });

    it("400 without job_id", async () => {
      const r = await act({ action: "analytics" });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "job_id is required");
    });

    it("returns analytics.json on success", async () => {
      useRoutes([{ method: "GET", match: `${UPSTREAM}/jobs/job_an1/analytics.json`, respond: () => json(200, { manim: 2, wan: 1 }) }]);
      const r = await act({ action: "analytics", job_id: "job_an1" });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { manim: 2, wan: 1 });
    });

    it("passes a missing analytics.json through as the upstream status", async () => {
      useRoutes([{ method: "GET", match: `${UPSTREAM}/jobs/job_an2/analytics.json`, respond: () => text(404, "") }]);
      const r = await act({ action: "analytics", job_id: "job_an2" });
      assert.equal(r.status, 404);
      assert.deepEqual(r.body, { error: "Analytics not available", status: 404 });
    });
  });

  describe("avatar_bulk_status", () => {
    it("401 without Authorization", async () => {
      const r = await act({ action: "avatar_bulk_status", job_id: "j" }, { auth: false });
      assert.equal(r.status, 401);
    });

    it("400 without job_id", async () => {
      const r = await act({ action: "avatar_bulk_status" });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "job_id is required");
    });

    it("returns avatar_status.json on success", async () => {
      useRoutes([{ method: "GET", match: `${UPSTREAM}/jobs/job_ab1/avatar_status.json`, respond: () => json(200, { sections: 4 }) }]);
      const r = await act({ action: "avatar_bulk_status", job_id: "job_ab1" });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { sections: 4 });
    });

    it("passes a missing avatar_status.json through as the upstream status", async () => {
      useRoutes([{ method: "GET", match: `${UPSTREAM}/jobs/job_ab2/avatar_status.json`, respond: () => text(404, "") }]);
      const r = await act({ action: "avatar_bulk_status", job_id: "job_ab2" });
      assert.equal(r.status, 404);
      assert.deepEqual(r.body, { error: "Avatar status not available", status: 404 });
    });
  });
});
