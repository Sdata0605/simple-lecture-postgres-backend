import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import "./helpers.js";
import { router } from "../functions/ai-generate-dpp/index.js";
import { mountRouter, closeDb } from "./_group00-harness.js";

// Covers the request checks and the topic lookup. A full run needs a subject_topics row, which needs a
// subject and category chain; that path is not exercised here.
let app;
const ask = (body) => app.post("/", body);

describe("ai-generate-dpp", () => {
  before(async () => {
    app = await mountRouter("/", router);
  });
  after(async () => {
    await app.close();
    await closeDb();
  });

  it("requires topic_id", async () => {
    const r = await ask({});
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "topic_id is required");
  });

  it("a malformed topic_id is a 500 'Failed to fetch topic'", async () => {
    const r = await ask({ topic_id: "not-a-uuid" });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "Failed to fetch topic");
  });

  it("an unknown topic is a 404", async () => {
    const id = crypto.randomUUID();
    const r = await ask({ topic_id: id });
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: "Topic not found", topic_id: id });
  });
});
