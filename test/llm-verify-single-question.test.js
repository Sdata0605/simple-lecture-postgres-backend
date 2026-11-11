import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser } from "./helpers.js";
import { serveRouter, hitAt } from "./route-harness.js";
import { router } from "../functions/llm-verify-single-question/index.js";

describe("llm-verify-single-question", () => {
  let r;
  let user;
  before(async () => {
    await startServer();
    r = await serveRouter("/functions/v1/llm-verify-single-question", router);
    user = await makeUser();
  });
  after(async () => {
    await r.close();
    await stopServer();
  });

  it("requires a Bearer token", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/llm-verify-single-question", {
      body: { questionId: "00000000-0000-4000-8000-000000000000" },
    });
    assert.equal(res.status, 401);
  });

  it("returns 500 when the question does not exist", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/llm-verify-single-question", {
      body: { questionId: "00000000-0000-4000-8000-000000000000" },
      headers: { Authorization: `Bearer ${user.access}` },
    });
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: "Question not found" });
  });

  it("returns 500 for a malformed question id", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/llm-verify-single-question", {
      body: { questionId: "nope" },
      headers: { Authorization: `Bearer ${user.access}` },
    });
    assert.equal(res.status, 500);
    assert.match(res.body.error, /uuid/i);
  });
});
