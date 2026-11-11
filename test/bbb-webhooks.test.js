import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer } from "./helpers.js";
import { serveRouter, setEnv } from "./router-harness.js";
import { router } from "../functions/bbb-webhooks/index.js";

const unknownClass = () => `class-00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, "0")}`;

describe("bbb-webhooks", () => {
  let svc, restore;
  before(async () => {
    await startServer();
    svc = await serveRouter(router);
    restore = setEnv({ BBB_WEBHOOK_SECRET: undefined, PUBLIC_BASE_URL: undefined });
  });
  after(async () => {
    restore?.();
    await svc?.close();
    await stopServer();
  });

  it("accepts a meeting-created event for a class id", async () => {
    const r = await svc.post({ header: { name: "meeting-created" }, data: { id: unknownClass() } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { success: true });
  });

  it("ignores events for meetings it cannot map", async () => {
    const r = await svc.post([{ header: { name: "meeting-ended" }, data: { id: "some-other-meeting" } }]);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { success: true });
  });

  it("does not fail when attendance cannot be written", async () => {
    const r = await svc.post({
      header: { name: "user-joined" },
      data: { id: unknownClass(), attributes: { user: { "external-user-id": "00000000-0000-4000-8000-000000000009", name: "X" } } },
    });
    assert.equal(r.status, 200);
  });

  it("accepts form data with a JSON event field", async () => {
    const payload = JSON.stringify({ header: { name: "meeting-ended" }, data: { id: unknownClass() } });
    const r = await fetch(`${svc.base}/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ event: payload }).toString(),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { success: true });
  });

  it("requires the webhook secret when one is configured", async () => {
    const off = setEnv({ BBB_WEBHOOK_SECRET: "whsec-test" });
    try {
      const denied = await svc.post({ header: { name: "meeting-ended" }, data: { id: unknownClass() } });
      assert.equal(denied.status, 401);
      const ok = await svc.post({ header: { name: "meeting-ended" }, data: { id: unknownClass() } }, { "x-webhook-secret": "whsec-test" });
      assert.equal(ok.status, 200);
    } finally {
      off();
    }
  });
});
