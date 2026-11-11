import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser } from "./helpers.js";
import { startFakeB2, useFakeB2Env } from "./b2-fake-server.js";
import { serveRouter } from "./router-harness.js";
import { router } from "../functions/b2-list-files/index.js";

describe("b2-list-files", () => {
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
    const r = await svc.post({ prefix: "files/" });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "No authorization header");
  });

  it("lists files and folders with download URLs", async () => {
    const u = await makeUser();
    const r = await svc.post({ prefix: "files/" }, { Authorization: `Bearer ${u.access}` });
    assert.equal(r.status, 200);
    assert.equal(r.body.files.length, 1);
    assert.equal(r.body.files[0].fileName, "files/doc.pdf");
    assert.equal(r.body.files[0].metadata, null);
    assert.match(r.body.files[0].downloadUrl, /\/file\/test-bucket\/files\/doc\.pdf$/);
    assert.deepEqual(r.body.folders, [{ name: "files/", isFolder: true }]);
    assert.equal(r.body.nextFileName, null);
  });
});
