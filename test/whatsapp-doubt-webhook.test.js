import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { pool } from "../functions/_shared/db.js";
import { router } from "../functions/whatsapp-doubt-webhook/index.js";

const SECRET = "test-webhook-secret-not-real";
let server;
let base;

const post = async (body, headers = {}) => {
  const r = await fetch(`${base}/functions/v1/whatsapp-doubt-webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

describe("whatsapp-doubt-webhook", () => {
  before(async () => {
    delete process.env.WACTO_API_TOKEN; // no WhatsApp reply can be sent from tests
    delete process.env.LOVABLE_API_KEY;
    const app = express();
    app.use(express.json());
    app.use("/functions/v1/whatsapp-doubt-webhook", router);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    await pool.end();
  });

  it("ignores a payload with no sender or text", async () => {
    const r = await post({ message: { text: { body: "" } } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { status: "ignored", reason: "no phone or text" });
  });

  it("reports the missing Wacto token before any AI or WhatsApp call", async () => {
    const r = await post({ from: "919999999999", text: { body: "What is light?" } });
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: "WACTO_API_TOKEN not configured" });
  });

  it("rejects a bad webhook secret when one is configured", async () => {
    process.env.WHATSAPP_WEBHOOK_SECRET = SECRET;
    try {
      const r = await post({ from: "919999999999", text: { body: "hi" } }, { "x-webhook-secret": "wrong" });
      assert.equal(r.status, 401);
      const ok = await post({ from: "919999999999" }, { "x-webhook-secret": SECRET });
      assert.equal(ok.body.status, "ignored");
    } finally {
      delete process.env.WHATSAPP_WEBHOOK_SECRET;
    }
  });
});
