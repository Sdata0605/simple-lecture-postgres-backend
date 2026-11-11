// Upload and public-read routes of the local storage (/storage/v1/object/...).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { startServer, stopServer, base, call, makeUser } from "./helpers.js";
import { UPLOAD_ROOT } from "../functions/_shared/storage.js";

const PNG = Buffer.concat([
  Buffer.from("89504e470d0a1a0a", "hex"),
  Buffer.from("storage upload test bytes"),
]);
const MB = 1024 * 1024;

// Folders created during the run, removed in `after`.
const created = [];
const bucketDir = (bucket, sub) => path.join(UPLOAD_ROOT, bucket, sub);

async function uploadMultipart(token, bucket, objectPath, bytes, { type = "image/png", upsert } = {}) {
  const form = new FormData();
  form.append("cacheControl", "3600");
  form.append("", new Blob([bytes], { type }), objectPath.split("/").pop());
  const headers = { Authorization: `Bearer ${token}` };
  if (upsert !== undefined) headers["x-upsert"] = String(upsert);
  return call("POST", `/storage/v1/object/${bucket}/${objectPath}`, { raw: form, headers });
}

describe("storage upload and public read", () => {
  let user;
  let objectPath;
  before(async () => {
    await startServer();
    user = await makeUser();
    objectPath = `${user.id}/upload-${Date.now()}.png`;
    created.push(bucketDir("chat-files", user.id));
  });
  after(async () => {
    for (const dir of created) await fs.rm(dir, { recursive: true, force: true });
    await stopServer();
  });

  it("refuses an anonymous upload with 401", async () => {
    const r = await call("POST", `/storage/v1/object/chat-files/${user.id}/anon.png`, {
      raw: PNG,
      headers: { "Content-Type": "image/png" },
    });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "Unauthorized");
  });

  it("uploads a signed-in multipart file, and the public URL returns the same bytes as image/png", async () => {
    const r = await uploadMultipart(user.access, "chat-files", objectPath, PNG);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.Key, `chat-files/${objectPath}`);
    assert.equal(r.body.path, objectPath);

    const res = await fetch(`${base}/storage/v1/object/public/chat-files/${objectPath}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("cache-control"), "public, max-age=3600");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  });

  it("accepts a raw-bytes upload with its Content-Type", async () => {
    const rawPath = `${user.id}/raw-${Date.now()}.png`;
    const r = await call("POST", `/storage/v1/object/chat-files/${rawPath}`, {
      raw: PNG,
      headers: { Authorization: `Bearer ${user.access}`, "Content-Type": "image/png" },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const res = await fetch(`${base}/storage/v1/object/public/chat-files/${rawPath}`);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  });

  it("refuses an unknown bucket with 400", async () => {
    const r = await uploadMultipart(user.access, "no-such-bucket", `${user.id}/x.png`, PNG);
    assert.equal(r.status, 400);
    assert.equal(r.body.message, "Bucket not found");
  });

  it("refuses a file over the bucket limit with 413", async () => {
    const big = Buffer.alloc(10 * MB + 1, 1);
    const r = await uploadMultipart(user.access, "chat-files", `${user.id}/big-${Date.now()}.png`, big);
    assert.equal(r.status, 413);
    assert.equal(r.body.error, "EntityTooLarge");
  });

  it("refuses a disallowed file type with 415", async () => {
    const r = await uploadMultipart(user.access, "chat-files", `${user.id}/evil-${Date.now()}.exe`, PNG, {
      type: "application/octet-stream",
    });
    assert.equal(r.status, 415);
  });

  it("does not serve a private bucket on the public route (404)", async () => {
    const privatePath = `${user.id}/doc-${Date.now()}.pdf`;
    created.push(bucketDir("uploaded-question-documents", user.id));
    const r = await uploadMultipart(user.access, "uploaded-question-documents", privatePath, Buffer.from("%PDF-1.4 test"), {
      type: "application/pdf",
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const res = await fetch(`${base}/storage/v1/object/public/uploaded-question-documents/${privatePath}`);
    assert.equal(res.status, 404);
  });

  it("refuses a duplicate without x-upsert with 409, and allows it with x-upsert true", async () => {
    const dupPath = `${user.id}/dup-${Date.now()}.png`;
    assert.equal((await uploadMultipart(user.access, "chat-files", dupPath, PNG)).status, 200);

    const again = await uploadMultipart(user.access, "chat-files", dupPath, PNG, { upsert: false });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, "Duplicate");

    const replaced = await uploadMultipart(user.access, "chat-files", dupPath, PNG, { upsert: true });
    assert.equal(replaced.status, 200);
  });

  it("refuses path traversal on upload and on public read", async () => {
    const up = await uploadMultipart(user.access, "chat-files", `..%2F..%2Fevil-${Date.now()}.png`, PNG);
    assert.equal(up.status, 400);
    assert.equal(up.body.error, "InvalidKey");

    const read = await fetch(`${base}/storage/v1/object/public/chat-files/a..%2F..%2Fpackage.json`);
    assert.equal(read.status, 400);
  });
});
