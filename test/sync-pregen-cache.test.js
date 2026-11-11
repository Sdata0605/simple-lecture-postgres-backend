import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { q } from "./helpers.js";
import { pool } from "../functions/_shared/db.js";
import { router } from "../functions/sync-pregen-cache/index.js";

const CRON = "test-cron-key-not-real-0005";
const tag = `pg5${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ids = { a: `${tag}-a`, b: `${tag}-b` };
let server;
let base;
let stub;
let stubBase;
let apiCalls = 0;

// A local stand-in for the AI Teaching API, so the sync never reaches a real server.
function startStub() {
  const app = express();
  app.use(express.json());
  app.get("/questions", (req, res) => {
    apiCalls++;
    res.json({
      questions: [
        { question_id: ids.a, question_text: "What is force?", subject_id: "sub-1", subject_name: "Physics" },
        { question_id: ids.b, question_text: "What is work?", subject_id: "sub-1" },
        { question_text: "no id here" },
      ],
    });
  });
  app.post("/ai-teaching-assistant", (req, res) => res.json({ slides: [req.body.question] }));
  return app.listen(0, "127.0.0.1");
}

describe("sync-pregen-cache", () => {
  before(async () => {
    process.env.PREGEN_CRON_KEY = CRON;
    stub = startStub();
    await once(stub, "listening");
    stubBase = `http://127.0.0.1:${stub.address().port}`;
    process.env.AI_TEACHING_API_BASE = stubBase;

    const app = express();
    app.use(express.json());
    app.use("/functions/v1/sync-pregen-cache", router);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await q("DELETE FROM public.pregen_question_cache WHERE question_id LIKE $1", [`${tag}%`]);
    await new Promise((r) => server.close(r));
    await new Promise((r) => stub.close(r));
    await pool.end();
  });

  it("refuses requests without the cron key and calls nothing", async () => {
    const before = apiCalls;
    const r = await fetch(`${base}/functions/v1/sync-pregen-cache`, { method: "POST" });
    assert.equal(r.status, 401);
    assert.equal(apiCalls, before);
  });

  it("caches ready presentations and skips entries without an id", async () => {
    const r = await fetch(`${base}/functions/v1/sync-pregen-cache`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CRON}` },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { synced: 2, failed: 0, skipped: 1, total: 3 });
    const rows = await q("SELECT question_id, subject_id FROM public.pregen_question_cache WHERE question_id LIKE $1 ORDER BY question_id", [`${tag}%`]);
    assert.deepEqual(rows.map((x) => x.question_id), [ids.a, ids.b].sort());
  });

  it("skips questions already cached on the next run", async () => {
    const r = await fetch(`${base}/functions/v1/sync-pregen-cache`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CRON}` },
    });
    assert.deepEqual(await r.json(), { synced: 0, failed: 0, skipped: 3, total: 3 });
  });
});
