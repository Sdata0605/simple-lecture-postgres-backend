import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { router } from "../functions/offline-download-api/index.js";

// The function router is served on its own port so the test does not depend on app.js mounting it.
let fnServer;
let fnBase;
const api = async (body, headers = {}) => {
  const res = await fetch(fnBase + "/", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const bearer = (u) => ({ Authorization: `Bearer ${u.access}` });

let course;
let sched;
let recording;
const createdUsers = [];

describe("offline-download-api", () => {
  before(async () => {
    await startServer();
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/", router);
    fnServer = app.listen(0, "127.0.0.1");
    await once(fnServer, "listening");
    fnBase = `http://127.0.0.1:${fnServer.address().port}`;

    course = randomUUID();
    await q("INSERT INTO public.courses (id, name, slug) VALUES ($1, $2, $3)", [course, "Offline test course", `offline-test-${course}`]);
    sched = randomUUID();
    await q("INSERT INTO public.scheduled_classes (id, course_id, subject, scheduled_at) VALUES ($1, $2, 'Maths', now())", [sched, course]);
    recording = randomUUID();
    await q(
      `INSERT INTO public.class_recordings (id, scheduled_class_id, course_id, original_filename, duration_seconds, file_size_bytes, b2_encrypted_path)
       VALUES ($1, $2, $3, 'lesson.mp4', 1800, 2048, 'enc/lesson.bin')`,
      [recording, sched, course]
    );
  });

  after(async () => {
    const ids = createdUsers.map((u) => u.id);
    if (ids.length) await q("DELETE FROM public.offline_downloads WHERE user_id = ANY($1)", [ids]);
    await q("DELETE FROM public.class_recordings WHERE id = $1", [recording]);
    await q("DELETE FROM public.scheduled_classes WHERE id = $1", [sched]);
    await q("DELETE FROM public.courses WHERE id = $1", [course]);
    await new Promise((r) => fnServer.close(r));
    await stopServer();
  });

  async function user() {
    const u = await makeUser();
    createdUsers.push(u);
    return u;
  }

  it("requires an Authorization header", async () => {
    const r = await api({ action: "list" });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "Authorization required");
  });

  it("rejects a forged token", async () => {
    const r = await api({ action: "list" }, { Authorization: "Bearer not.a.token" });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "Invalid token");
  });

  it("returns 400 for an unknown action", async () => {
    const u = await user();
    const r = await api({ action: "explode" }, bearer(u));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "Unknown action");
  });

  it("request: returns a download with key, iv and expiry", async () => {
    const u = await user();
    const r = await api({ action: "request", recording_id: recording, quality: "720p", device_id: "dev-1" }, bearer(u));
    assert.equal(r.status, 200);
    assert.match(r.body.downloadId, /^[0-9a-f-]{36}$/);
    assert.equal(r.body.fileSize, 2048);
    assert.equal(r.body.iv.length, 32);
    assert.ok(r.body.encryptedKey.length > 64);
    assert.match(r.body.downloadUrl, /\/recordings\/enc\/lesson\.bin$/);
    assert.ok(r.body.expiresAt > Date.now());
  });

  it("request: repeat request for the same device replaces the row", async () => {
    const u = await user();
    await api({ action: "request", recording_id: recording, quality: "720p", device_id: "dev-x" }, bearer(u));
    const again = await api({ action: "request", recording_id: recording, quality: "480p", device_id: "dev-x" }, bearer(u));
    assert.equal(again.status, 200);
    const rows = await q("SELECT quality FROM public.offline_downloads WHERE user_id = $1 AND device_id = 'dev-x'", [u.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].quality, "480p");
  });

  it("request: refuses an unknown recording", async () => {
    const u = await user();
    const r = await api({ action: "request", recording_id: randomUUID(), device_id: "d" }, bearer(u));
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "Recording not found");
    const bad = await api({ action: "request", recording_id: "not-a-uuid", device_id: "d" }, bearer(u));
    assert.equal(bad.body.error, "Recording not found");
  });

  it("request: refuses once the per-user maximum (10) is reached", async () => {
    const u = await user();
    for (let i = 0; i < 10; i++) {
      await q(
        "INSERT INTO public.offline_downloads (recording_id, user_id, device_id, download_status) VALUES ($1, $2, $3, 'ready')",
        [recording, u.id, `cap-${i}`]
      );
    }
    const r = await api({ action: "request", recording_id: recording, device_id: "cap-new" }, bearer(u));
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "Maximum 10 offline downloads reached");
  });

  it("list: returns only the caller's non-revoked downloads with nested recording", async () => {
    const u = await user();
    const other = await user();
    await api({ action: "request", recording_id: recording, device_id: "list-1" }, bearer(u));
    await api({ action: "request", recording_id: recording, device_id: "list-2" }, bearer(other));
    const r = await api({ action: "list" }, bearer(u));
    assert.equal(r.status, 200);
    assert.equal(r.body.downloads.length, 1);
    assert.equal(r.body.downloads[0].recording.original_filename, "lesson.mp4");
    assert.equal(r.body.downloads[0].recording.scheduled_class.subject, "Maths");
    assert.equal(r.body.downloads[0].recording.scheduled_class.course.name, "Offline test course");
  });

  it("complete: marks the caller's own download completed", async () => {
    const u = await user();
    const made = await api({ action: "request", recording_id: recording, device_id: "c-1" }, bearer(u));
    const r = await api({ action: "complete", download_id: made.body.downloadId }, bearer(u));
    assert.deepEqual(r.body, { success: true });
    const [row] = await q("SELECT download_status, downloaded_at FROM public.offline_downloads WHERE id = $1", [made.body.downloadId]);
    assert.equal(row.download_status, "completed");
    assert.ok(row.downloaded_at);
  });

  it("complete: cannot change another user's download", async () => {
    const owner = await user();
    const attacker = await user();
    const made = await api({ action: "request", recording_id: recording, device_id: "c-2" }, bearer(owner));
    const r = await api({ action: "complete", download_id: made.body.downloadId }, bearer(attacker));
    assert.equal(r.body.success, true);
    const [row] = await q("SELECT download_status FROM public.offline_downloads WHERE id = $1", [made.body.downloadId]);
    assert.equal(row.download_status, "ready");
  });

  it("revoke: hides the download from list and records the reason", async () => {
    const u = await user();
    const made = await api({ action: "request", recording_id: recording, device_id: "r-1" }, bearer(u));
    const r = await api({ action: "revoke", download_id: made.body.downloadId, reason: "lost device" }, bearer(u));
    assert.deepEqual(r.body, { success: true });
    const [row] = await q("SELECT is_revoked, revoked_reason FROM public.offline_downloads WHERE id = $1", [made.body.downloadId]);
    assert.equal(row.is_revoked, true);
    assert.equal(row.revoked_reason, "lost device");
    const list = await api({ action: "list" }, bearer(u));
    assert.equal(list.body.downloads.length, 0);
  });
});
