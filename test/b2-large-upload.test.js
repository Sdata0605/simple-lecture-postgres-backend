import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser } from "./helpers.js";
import { startFakeB2, useFakeB2Env } from "./b2-fake-server.js";
import { serveRouter } from "./router-harness.js";
import { router } from "../functions/b2-large-upload/index.js";

describe("b2-large-upload", () => {
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

  const act = (u, body) => svc.post(body, { Authorization: `Bearer ${u.access}` });

  it("requires a bearer token", async () => {
    const r = await svc.post({ action: "start" });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "No authorization header");
  });

  it("rejects an unknown action", async () => {
    const u = await makeUser();
    const r = await act(u, { action: "nope" });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "Unknown action: nope");
  });

  it("start returns a B2 file id", async () => {
    const u = await makeUser();
    const r = await act(u, { action: "start", fileName: "videos/big.mp4", contentType: "video/mp4" });
    assert.deepEqual(r.body, { success: true, fileId: "fid-large" });
  });

  it("upload-part, finish and cancel succeed", async () => {
    const u = await makeUser();
    const part = await act(u, { action: "upload-part", fileId: "fid-large", partNumber: 1, partData: Buffer.from("abc").toString("base64") });
    assert.equal(part.status, 200);
    assert.equal(part.body.success, true);
    assert.equal(part.body.partSha1.length, 40);

    const fin = await act(u, { action: "finish", fileId: "fid-large", partSha1Array: [part.body.partSha1] });
    assert.equal(fin.status, 200);
    assert.equal(fin.body.file.fileName, "big.mp4");

    const can = await act(u, { action: "cancel", fileId: "fid-large" });
    assert.deepEqual(can.body, { success: true });
  });
});
