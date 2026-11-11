import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer } from "./helpers.js";
import { mountRouter, request } from "./group02-harness.js";
import { router } from "../functions/create-test-accounts/index.js";

describe("create-test-accounts", () => {
  let app;
  before(async () => {
    await startServer();
    app = await mountRouter("/functions/v1/create-test-accounts", router);
  });
  after(async () => {
    await app.close();
    await stopServer();
  });

  it("stays disabled, as the one-shot bootstrap was", async () => {
    const r = await request(app.base, { body: {} });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "Disabled");
  });
});
