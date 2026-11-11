// Loads .env and the test-only guards before any database code runs.
import "./helpers.js";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { router } from "../functions/ai-generate-solution/index.js";
import { mountRouter, closeDb } from "./_group00-harness.js";

// Only the lookup-failure paths are tested: creating a parsed_questions_pending row needs a whole
// document/category/subject/chapter chain. The AI and save path is covered by reading the code.
let app;
const ask = (body) => app.post("/", body);

describe("ai-generate-solution", () => {
  before(async () => {
    app = await mountRouter("/", router);
  });
  after(async () => {
    await app.close();
    await closeDb();
  });

  it("a malformed questionId is a 500 (no database lookup)", async () => {
    const r = await ask({ questionId: "not-a-uuid" });
    assert.equal(r.status, 500);
    assert.match(r.body.error, /multiple \(or no\) rows returned/);
  });

  it("a missing question is a 500", async () => {
    const r = await ask({ questionId: crypto.randomUUID() });
    assert.equal(r.status, 500);
    assert.match(r.body.error, /multiple \(or no\) rows returned/);
  });

  it("no body is a 500", async () => {
    const r = await ask(undefined);
    assert.equal(r.status, 500);
  });
});
