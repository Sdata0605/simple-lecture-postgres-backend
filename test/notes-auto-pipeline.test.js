import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { serveRouter, hitAt } from "./route-harness.js";
import {
  router,
  toApiFormat,
  toApiDifficulty,
  readGenerationState,
  findDocumentId,
  extractContentMarkdown,
} from "../functions/notes-auto-pipeline/index.js";

// Only validation and auth paths are exercised. No tick is run, so no queue item is claimed and
// no Notes API or self-tick is contacted.
describe("notes-auto-pipeline", () => {
  let r;
  let student;
  let admin;
  const SECRET = "x".repeat(40);
  const saved = {
    secret: process.env.NOTES_PIPELINE_INTERNAL_SECRET,
    svc: process.env.SERVICE_KEY,
  };
  before(async () => {
    await startServer();
    r = await serveRouter("/functions/v1/notes-auto-pipeline", router);
    student = await makeUser();
    admin = await makeUser();
    await q("INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')", [admin.id]);
    process.env.NOTES_PIPELINE_INTERNAL_SECRET = SECRET;
    process.env.SERVICE_KEY = "test-service-key-not-real";
  });
  after(async () => {
    await q("DELETE FROM public.user_roles WHERE user_id = $1 AND role = 'admin'", [admin.id]);
    for (const [k, envName] of [["secret", "NOTES_PIPELINE_INTERNAL_SECRET"], ["svc", "SERVICE_KEY"]]) {
      if (saved[k] === undefined) delete process.env[envName];
      else process.env[envName] = saved[k];
    }
    await r.close();
    await stopServer();
  });

  const url = "/functions/v1/notes-auto-pipeline";

  it("refuses to run without a strong internal secret", async () => {
    const prev = process.env.NOTES_PIPELINE_INTERNAL_SECRET;
    process.env.NOTES_PIPELINE_INTERNAL_SECRET = "short";
    try {
      const res = await hitAt(r.base, "POST", url, { body: { action: "tick" } });
      assert.equal(res.status, 500);
      assert.match(res.body.error, /internal secret/);
    } finally {
      process.env.NOTES_PIPELINE_INTERNAL_SECRET = prev;
    }
  });

  it("answers tick only with the service key", async () => {
    const res = await hitAt(r.base, "POST", url, { body: { action: "tick" } });
    assert.equal(res.status, 401);
  });

  it("requires a user token for admin actions, and an admin role", async () => {
    const none = await hitAt(r.base, "POST", url, { body: { action: "stop", run_id: "x" } });
    assert.equal(none.status, 401);
    const notAdmin = await hitAt(r.base, "POST", url, {
      body: { action: "stop", run_id: "x" },
      headers: { Authorization: `Bearer ${student.access}` },
    });
    assert.equal(notAdmin.status, 403);
    assert.deepEqual(notAdmin.body, { error: "Admin access required" });
  });

  it("validates pause and resume input for an admin", async () => {
    const h = { Authorization: `Bearer ${admin.access}` };
    const noRun = await hitAt(r.base, "POST", url, { body: { action: "pause", subject_id: "s" }, headers: h });
    assert.equal(noRun.status, 400);
    assert.deepEqual(noRun.body, { error: "run_id is required" });
    const noSubject = await hitAt(r.base, "POST", url, { body: { action: "resume", run_id: "r" }, headers: h });
    assert.equal(noSubject.status, 400);
  });

  it("returns 409 when pausing a run that does not exist", async () => {
    const res = await hitAt(r.base, "POST", url, {
      body: {
        action: "pause",
        run_id: "00000000-0000-4000-8000-000000000000",
        subject_id: "00000000-0000-4000-8000-000000000001",
      },
      headers: { Authorization: `Bearer ${admin.access}` },
    });
    assert.equal(res.status, 409);
  });

  it("rejects start without topics and an invalid API base", async () => {
    const h = { Authorization: `Bearer ${admin.access}` };
    const none = await hitAt(r.base, "POST", url, { body: { action: "start", subject_id: "s" }, headers: h });
    assert.equal(none.status, 400);
    assert.deepEqual(none.body, { error: "subject_id and topic_ids are required" });
    const badBase = await hitAt(r.base, "POST", url, {
      body: { action: "start", subject_id: "s", topic_ids: ["t"], api_base: "ftp://nope" },
      headers: h,
    });
    assert.equal(badBase.status, 400);
    assert.deepEqual(badBase.body, { error: "Invalid Notes API base URL" });
  });

  it("answers unknown actions with 400, and other methods with 405", async () => {
    const h = { Authorization: `Bearer ${admin.access}` };
    const unknown = await hitAt(r.base, "POST", url, { body: { action: "explode" }, headers: h });
    assert.equal(unknown.status, 400);
    assert.deepEqual(unknown.body, { error: "Unknown action" });
    const get = await hitAt(r.base, "GET", url);
    assert.equal(get.status, 405);
  });

  it("maps formats, difficulty and generation state", () => {
    assert.equal(toApiFormat("single_choice"), "mcq");
    assert.equal(toApiFormat("short_answer"), "short_answer");
    assert.equal(toApiFormat(null), "long_answer");
    assert.equal(toApiDifficulty("Hard"), "Hard");
    assert.equal(toApiDifficulty("low"), "Easy");
    assert.equal(toApiDifficulty(undefined), "Medium");
    const done = readGenerationState({ topics_done: 3, topics_pending: 0, topics_failed: 0, status: "ready" });
    assert.equal(done.completed, true);
    assert.equal(readGenerationState({ status: "failed" }).failed, true);
  });

  it("finds the document id and the content markdown", () => {
    assert.equal(findDocumentId({ result: { document_id: "d1" } }), "d1");
    assert.equal(findDocumentId({ nothing: true }), null);
    const md = extractContentMarkdown({ full_content: { markdown: "# Hi" } }, {});
    assert.equal(md, "# Hi");
    assert.equal(extractContentMarkdown(null, { notes_markdown: "n" }), "n");
  });
});
