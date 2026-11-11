import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer } from "./helpers.js";
import { serveRouter, hitAt } from "./route-harness.js";
import { router, hooks } from "../functions/extract-questions-from-document/index.js";

describe("extract-questions-from-document", () => {
  let r;
  const realFetch = hooks.fetch;
  before(async () => {
    await startServer();
    r = await serveRouter("/functions/v1/extract-questions-from-document", router);
  });
  after(async () => {
    hooks.fetch = realFetch;
    await r.close();
    await stopServer();
  });

  it("returns 500 with the database message for a malformed document id", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/extract-questions-from-document", {
      body: { documentId: "not-a-uuid" },
    });
    assert.equal(res.status, 500);
    assert.equal(typeof res.body.error, "string");
    assert.match(res.body.error, /uuid/i);
  });

  it("returns 500 when the document does not exist (foreign key)", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/extract-questions-from-document", {
      body: { documentId: "00000000-0000-4000-8000-000000000000" },
    });
    assert.equal(res.status, 500);
    assert.match(res.body.error, /foreign key|violates/i);
  });

  it("returns 500 when documentId is missing", async () => {
    const res = await hitAt(r.base, "POST", "/functions/v1/extract-questions-from-document", { body: {} });
    assert.equal(res.status, 500);
  });
});
