import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { startFakeB2, useFakeB2Env } from "./b2-fake-server.js";
import { serveRouter } from "./router-harness.js";
import { router } from "../functions/b2-delete-file/index.js";

describe("b2-delete-file", () => {
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
    const r = await svc.post({ fileName: "a", fileId: "b" });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "No authorization header");
  });

  it("rejects an invalid token", async () => {
    const r = await svc.post({ fileName: "a", fileId: "b" }, { Authorization: "Bearer nope" });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "Unauthorized");
  });

  it("requires fileName and fileId", async () => {
    const u = await makeUser();
    const r = await act(u, { fileName: "a" });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "fileName and fileId are required");
  });

  it("deletes the B2 version and the storage_files row", async () => {
    const u = await makeUser();
    const fid = `del-${Math.random().toString(36).slice(2)}`;
    await q(
      `INSERT INTO public.storage_files (file_name, file_path, file_size, file_type, b2_file_id, entity_type)
       VALUES ('doc.pdf', $1, 1, 'application/pdf', $2, 'chapter')`,
      [`test-del/${fid}.pdf`, fid]
    );
    const r = await act(u, { fileName: `test-del/${fid}.pdf`, fileId: fid });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { success: true, message: "File deleted successfully" });
    assert.ok(fake.calls.some((c) => c.path === "/b2api/v2/b2_delete_file_version"));
    const left = await q("SELECT id FROM public.storage_files WHERE b2_file_id = $1", [fid]);
    assert.equal(left.length, 0);
  });
});
