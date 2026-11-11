import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { startFakeB2, useFakeB2Env } from "./b2-fake-server.js";
import { serveRouter } from "./router-harness.js";
import { router } from "../functions/b2-upload/index.js";
import { upload } from "../functions/_shared/storage.js";

describe("b2-upload", () => {
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
    const r = await svc.post({ storagePath: "x", filePath: "y" });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "No authorization header");
  });

  it("moves a temp file to B2 and records storage_files", async () => {
    const u = await makeUser();
    const tag = Math.random().toString(36).slice(2);
    const storagePath = `test-b2/${tag}.pdf`;
    const filePath = `chapters/test-b2-${tag}.pdf`;
    await upload("temp-uploads", storagePath, Buffer.from("%PDF-1.4 temp"));

    const r = await svc.post(
      {
        storagePath,
        filePath,
        fileName: `test-b2-${tag}.pdf`,
        fileType: "application/pdf",
        fileSize: 13,
        metadata: { entityType: "chapter" },
      },
      { Authorization: `Bearer ${u.access}` }
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.fileId, "fid-uploaded");
    assert.equal(r.body.filePath, filePath);
    assert.equal(r.body.storageFile.uploaded_by, u.id);
    assert.ok(fake.calls.some((c) => c.path === "/upload"));
    await q("DELETE FROM public.storage_files WHERE b2_file_id = 'fid-uploaded' AND file_path = $1", [filePath]);
  });

  it("returns 500 when the temp file is missing", async () => {
    const u = await makeUser();
    const r = await svc.post(
      { storagePath: "does/not/exist.pdf", filePath: "x.pdf", fileName: "x.pdf", fileType: "application/pdf", metadata: { entityType: "chapter" } },
      { Authorization: `Bearer ${u.access}` }
    );
    assert.equal(r.status, 500);
    assert.match(r.body.error, /^Failed to download temp file/);
  });
});
