import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser } from "./helpers.js";
import { serveRouter, hitAt } from "./route-harness.js";
import { router } from "../functions/kie-ai-common/index.js";

describe("kie-ai-common", () => {
  let user;
  let r;
  const saved = process.env.KIE_AI_API_KEY;
  before(async () => {
    await startServer();
    r = await serveRouter("/functions/v1/kie-ai-common", router);
    user = await makeUser();
  });
  after(async () => {
    if (saved === undefined) delete process.env.KIE_AI_API_KEY;
    else process.env.KIE_AI_API_KEY = saved;
    await r.close();
    await stopServer();
  });

  it("requires a Bearer token", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/kie-ai-common", { body: { action: "check_credit" } });
    assert.equal(res.status, 401);
  });

  it("returns 500 when KIE_AI_API_KEY is not configured", async () => {
    delete process.env.KIE_AI_API_KEY;
    const res = await hitAt(r.base, "POST", "/functions/v1/kie-ai-common", {
      body: { action: "check_credit" },
      headers: { Authorization: `Bearer ${user.access}` },
    });
    assert.equal(res.status, 500);
    assert.match(res.body.error, /KIE_AI_API_KEY/);
  });

  it("rejects get_download_url without a url", async () => {
    process.env.KIE_AI_API_KEY = "test-key-not-real";
    const res = await hitAt(r.base, "POST", "/functions/v1/kie-ai-common", {
      body: { action: "get_download_url" },
      headers: { Authorization: `Bearer ${user.access}` },
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "URL is required" });
  });

  it("rejects an unknown action", async () => {
    process.env.KIE_AI_API_KEY = "test-key-not-real";
    const res = await hitAt(r.base, "POST", "/functions/v1/kie-ai-common", {
      body: { action: "nope" },
      headers: { Authorization: `Bearer ${user.access}` },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Invalid action/);
  });
});
