import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { pool } from "../functions/_shared/db.js";
import { router } from "../functions/whatsapp-daily-nudge/index.js";

const CRON = "test-nudge-cron-key-not-real";
let server;
let base;

describe("whatsapp-daily-nudge", () => {
  before(async () => {
    process.env.WHATSAPP_NUDGE_CRON_KEY = CRON;
    delete process.env.WACTO_API_TOKEN; // no WhatsApp message can be sent from tests
    delete process.env.WACTO_SENDER_ID;
    const app = express();
    app.use(express.json());
    app.use("/functions/v1/whatsapp-daily-nudge", router);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    await pool.end();
  });

  it("refuses callers without the cron key", async () => {
    const r = await fetch(`${base}/functions/v1/whatsapp-daily-nudge`, { method: "POST" });
    assert.equal(r.status, 401);
  });

  it("reports the missing Wacto token instead of sending", async () => {
    const r = await fetch(`${base}/functions/v1/whatsapp-daily-nudge`, {
      method: "POST",
      headers: { Authorization: `Bearer ${CRON}` },
    });
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { error: "WACTO_API_TOKEN not configured" });
  });
});
