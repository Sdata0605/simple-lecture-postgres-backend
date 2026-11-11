import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import express from "express";
import { once } from "node:events";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { router } from "../functions/notes-backfill-presentation/index.js";

// The render server is replaced by a local HTTP server, so no real host is contacted.
let renderServer;
let renderBase;
let renderBody = null; // JSON text to serve, or null for 404
// The function router is served on its own port so the test does not depend on app.js mounting it.
let fnServerInst;
let fnBase;
async function post(_path, body, headers = {}) {
  const res = await fetch(fnBase + "/", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}
const FN = "/";

function presentation(n) {
  return JSON.stringify({ sections: Array.from({ length: n }, (_, i) => ({ id: i, title: `s${i}` })) });
}

describe("notes-backfill-presentation", () => {
  before(async () => {
    await startServer();
    const fnApp = express();
    fnApp.use(express.json({ limit: "1mb" }));
    fnApp.use("/", router);
    fnServerInst = fnApp.listen(0, "127.0.0.1");
    await once(fnServerInst, "listening");
    fnBase = `http://127.0.0.1:${fnServerInst.address().port}`;
    renderServer = http.createServer((req, res) => {
      if (renderBody === null) { res.writeHead(404); return res.end("nope"); }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(renderBody);
    });
    await new Promise((r) => renderServer.listen(0, "127.0.0.1", r));
    renderBase = `http://127.0.0.1:${renderServer.address().port}`;
    process.env.RENDER_SERVER_URL = renderBase;
  });
  after(async () => {
    delete process.env.RENDER_SERVER_URL;
    await new Promise((r) => renderServer.close(r));
    await new Promise((r) => fnServerInst.close(r));
    await stopServer();
  });

  it("rejects requests without a bearer token", async () => {
    const r = await post(FN, { jobId: "x", externalJobId: "y" });
    assert.equal(r.status, 401);
  });

  it("rejects a forged token", async () => {
    const r = await post(FN, { jobId: "x", externalJobId: "y" }, { Authorization: "Bearer not.a.token" });
    assert.equal(r.status, 401);
  });

  it("requires jobId and externalJobId", async () => {
    const u = await makeUser();
    const r = await post(FN, { jobId: "abc" }, { Authorization: `Bearer ${u.access}` });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /required/);
  });

  it("rejects an externalJobId with unsafe characters", async () => {
    const u = await makeUser();
    const r = await post(FN, { jobId: "abc", externalJobId: "../etc" }, { Authorization: `Bearer ${u.access}` });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "externalJobId format invalid");
  });

  it("returns cdn_http_fail when the render server has no file", async () => {
    const u = await makeUser();
    renderBody = null;
    const r = await post(FN, { jobId: "job-missing", externalJobId: "ext1" }, { Authorization: `Bearer ${u.access}` });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.reason, "cdn_http_fail");
    assert.equal(r.body.status, 404);
  });

  it("returns empty_or_invalid when the presentation has no sections", async () => {
    const u = await makeUser();
    renderBody = JSON.stringify({ sections: [] });
    const r = await post(FN, { jobId: "job-empty", externalJobId: "ext2" }, { Authorization: `Bearer ${u.access}` });
    assert.equal(r.body.reason, "empty_or_invalid");
  });

  it("writes the presentation when the stored row is empty", async () => {
    const u = await makeUser();
    const jobId = "tj" + Math.random().toString(36).slice(2, 7);
    await q("INSERT INTO public.video_generation_jobs (id, subject_id, created_by) VALUES ($1, $2, $3)", [jobId, randomUUID(), u.id]);
    try {
      renderBody = presentation(3);
      const r = await post(FN, { jobId, externalJobId: "ext3" }, { Authorization: `Bearer ${u.access}` });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      assert.equal(r.body.wrote, true);
      assert.equal(r.body.sections, 3);
      assert.equal(r.body.presentation.sections.length, 3);
      const [row] = await q("SELECT presentation_json FROM public.video_generation_jobs WHERE id = $1", [jobId]);
      assert.equal(row.presentation_json.sections.length, 3);
    } finally {
      await q("DELETE FROM public.video_generation_jobs WHERE id = $1", [jobId]);
    }
  });

  it("does not overwrite a row that already has as many sections", async () => {
    const u = await makeUser();
    const jobId = "tj" + Math.random().toString(36).slice(2, 7);
    await q(
      "INSERT INTO public.video_generation_jobs (id, subject_id, created_by, presentation_json) VALUES ($1, $2, $3, $4::jsonb)",
      [jobId, randomUUID(), u.id, presentation(5)]
    );
    try {
      renderBody = presentation(2);
      const r = await post(FN, { jobId, externalJobId: "ext4" }, { Authorization: `Bearer ${u.access}` });
      assert.equal(r.body.ok, true);
      assert.equal(r.body.wrote, false);
      const [row] = await q("SELECT presentation_json FROM public.video_generation_jobs WHERE id = $1", [jobId]);
      assert.equal(row.presentation_json.sections.length, 5);
    } finally {
      await q("DELETE FROM public.video_generation_jobs WHERE id = $1", [jobId]);
    }
  });

  it("reports wrote:false when the job row does not exist", async () => {
    const u = await makeUser();
    renderBody = presentation(1);
    const r = await post(FN, { jobId: randomUUID(), externalJobId: "ext5" }, { Authorization: `Bearer ${u.access}` });
    assert.equal(r.body.ok, true);
    assert.equal(r.body.wrote, false);
    assert.equal(r.body.presentation.sections.length, 1);
  });
});
