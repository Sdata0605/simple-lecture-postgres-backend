import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser } from "./helpers.js";
import { serveRouter } from "./router-harness.js";
import { router } from "../functions/approve-and-transfer-questions/index.js";

describe("approve-and-transfer-questions", () => {
  let svc;
  before(async () => {
    await startServer();
    svc = await serveRouter(router);
  });
  after(async () => {
    await svc?.close();
    await stopServer();
  });

  it("requires a token", async () => {
    const r = await svc.post({ questionIds: [] });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "Unauthorized");
  });

  it("requires a questionIds array", async () => {
    const u = await makeUser();
    const r = await svc.post({ questionIds: "x" }, { Authorization: `Bearer ${u.access}` });
    assert.equal(r.status, 400);
  });

  it("succeeds with no matching questions and records the client IP", async () => {
    const u = await makeUser();
    const r = await svc.post(
      { questionIds: ["00000000-0000-4000-8000-000000000000"] },
      { Authorization: `Bearer ${u.access}`, "x-forwarded-for": "203.0.113.7, 10.0.0.1" }
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.transferredCount, 0);
    assert.equal(r.body.approvedBy, u.id);
    assert.equal(r.body.approvedFrom, "203.0.113.7");
  });
});
