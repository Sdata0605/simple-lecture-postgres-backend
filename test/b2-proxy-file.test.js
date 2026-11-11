import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser } from "./helpers.js";
import { startFakeB2, useFakeB2Env } from "./b2-fake-server.js";
import { serveRouter } from "./router-harness.js";
import { router } from "../functions/b2-proxy-file/index.js";

describe("b2-proxy-file", () => {
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

  it("returns 401 without any token", async () => {
    const r = await svc.get("?path=files/doc.pdf");
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "No authorization provided");
  });

  it("returns 401 for an invalid token", async () => {
    const r = await svc.get("?path=files/doc.pdf&token=bad");
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "Unauthorized");
  });

  it("returns 400 without a path", async () => {
    const u = await makeUser();
    const r = await svc.get(`?token=${u.access}`);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "Missing file path");
  });

  it("streams the file for an authorised user, with PDF content type", async () => {
    const u = await makeUser();
    const r = await fetch(`${svc.base}/?path=files/doc.pdf`, {
      headers: { Authorization: `Bearer ${u.access}` },
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "application/pdf");
    assert.equal(r.headers.get("content-disposition"), "inline");
    assert.equal(await r.text(), "%PDF-1.4 fake");
  });

  it("returns 404 when B2 does not have the file", async () => {
    const u = await makeUser();
    const r = await svc.get(`?path=missing.bin&token=${u.access}`);
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "File not found");
  });
});
