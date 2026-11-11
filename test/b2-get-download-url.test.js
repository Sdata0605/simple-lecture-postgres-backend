import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser } from "./helpers.js";
import { startFakeB2, useFakeB2Env } from "./b2-fake-server.js";
import { serveRouter } from "./router-harness.js";
import { router } from "../functions/b2-get-download-url/index.js";

describe("b2-get-download-url", () => {
  let fake, restoreEnv, svc;
  before(async () => {
    await startServer();
    svc = await serveRouter(router);
    fake = await startFakeB2();
    restoreEnv = useFakeB2Env(fake.base);
  });
  after(async () => {
    restoreEnv?.();
    await svc?.close();
    await fake?.stop();
    await stopServer();
  });

  it("requires a bearer token", async () => {
    const r = await svc.post({ filePath: "x" });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "No authorization header");
  });

  it("requires filePath", async () => {
    const u = await makeUser();
    const r = await svc.post({}, { Authorization: `Bearer ${u.access}` });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "File path is required");
  });

  it("returns a signed download URL for an authorised user", async () => {
    const u = await makeUser();
    const r = await svc.post({ filePath: "files/my doc.pdf" }, { Authorization: `Bearer ${u.access}` });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.expiresIn, 3600);
    assert.match(r.body.downloadUrl, /\/file\/test-bucket\/files\/my%20doc\.pdf\?Authorization=dl-token$/);
  });
});
