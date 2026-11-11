import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { once } from "node:events";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { router } from "../functions/send-purchase-reminder-email/index.js";
import { sentMessages } from "../functions/_shared/mail.js";

// The AI gateway is replaced by a local stub (LOVABLE_API_URL). Mail stays in dry-run mode.
const CRON = "test-cron-secret";
const today = new Date().toISOString().split("T")[0];
let stub;
let stubReply = null;
let fnServer;
let fnBase;
const savedEnv = {};
let snapshot = { messages: [], logs: [] }; // rows for today that existed before this file ran
const ENV_KEYS = ["CRON_SECRET", "LOVABLE_API_KEY", "LOVABLE_API_URL", "MAIL_MODE"];

async function run(headers = { Authorization: `Bearer ${CRON}` }) {
  const res = await fetch(`${fnBase}/`, { method: "POST", headers });
  return { status: res.status, body: await res.json() };
}

// Logs today's reminder for every account, so a run sends nothing.
async function markAllReminded() {
  await q(
    `INSERT INTO public.purchase_reminder_email_logs (user_id, email, sent_date, status)
     SELECT id, email, $1::date, 'sent' FROM public.profiles WHERE email IS NOT NULL AND email <> ''
     ON CONFLICT (user_id, sent_date) DO NOTHING`,
    [today]
  );
}

describe("send-purchase-reminder-email", () => {
  before(async () => {
    await startServer();
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    snapshot.messages = await q("SELECT id, message_date::text AS message_date, subject_line, message_body, created_at FROM public.purchase_reminder_messages WHERE message_date = $1::date", [today]);
    snapshot.logs = await q("SELECT id, user_id, email, sent_date::text AS sent_date, status, error_message, created_at FROM public.purchase_reminder_email_logs WHERE sent_date = $1::date", [today]);

    stub = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        if (stubReply === null) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          return res.end("gateway down");
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: stubReply } }] }));
      });
    });
    stub.listen(0, "127.0.0.1");
    await once(stub, "listening");

    process.env.CRON_SECRET = CRON;
    process.env.LOVABLE_API_URL = `http://127.0.0.1:${stub.address().port}/v1/chat/completions`;
    process.env.LOVABLE_API_KEY = "test-gateway-key";
    process.env.MAIL_MODE = "dry-run";

    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/", router);
    fnServer = app.listen(0, "127.0.0.1");
    await once(fnServer, "listening");
    fnBase = `http://127.0.0.1:${fnServer.address().port}`;
  });

  after(async () => {
    try {
      // Put back exactly what was there for today before this file ran.
      await q("DELETE FROM public.purchase_reminder_email_logs WHERE sent_date = $1::date", [today]);
      await q("DELETE FROM public.purchase_reminder_messages WHERE message_date = $1::date", [today]);
      for (const r of snapshot.messages) {
        await q("INSERT INTO public.purchase_reminder_messages (id, message_date, subject_line, message_body, created_at) VALUES ($1, $2::date, $3, $4, $5)", [r.id, r.message_date, r.subject_line, r.message_body, r.created_at]);
      }
      for (const r of snapshot.logs) {
        await q("INSERT INTO public.purchase_reminder_email_logs (id, user_id, email, sent_date, status, error_message, created_at) VALUES ($1, $2, $3, $4::date, $5, $6, $7)", [r.id, r.user_id, r.email, r.sent_date, r.status, r.error_message, r.created_at]);
      }
    } finally {
      for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
      await new Promise((r) => fnServer.close(r));
      await new Promise((r) => stub.close(r));
      await stopServer();
    }
  });

  it("refuses callers without the cron secret", async () => {
    assert.equal((await run({})).status, 401);
  });

  it("fails clearly when the AI key is missing and today has no message yet", async () => {
    await q("DELETE FROM public.purchase_reminder_messages WHERE message_date = $1::date", [today]);
    const saved = process.env.LOVABLE_API_KEY;
    delete process.env.LOVABLE_API_KEY;
    try {
      const r = await run();
      assert.equal(r.status, 500);
      assert.equal(r.body.error, "LOVABLE_API_KEY is not configured");
    } finally {
      process.env.LOVABLE_API_KEY = saved;
    }
  });

  it("generates today's reminder message and stores it", async () => {
    await q("DELETE FROM public.purchase_reminder_messages WHERE message_date = $1::date", [today]);
    await markAllReminded();
    stubReply = '{"subject_line": "Courses await", "message_body": "Start learning now."}';
    const r = await run();
    assert.equal(r.status, 200);
    assert.equal(r.body.message, "All reminders already sent today");
    const [row] = await q("SELECT subject_line, message_body FROM public.purchase_reminder_messages WHERE message_date = $1::date", [today]);
    assert.equal(row.subject_line, "Courses await");
    assert.equal(row.message_body, "Start learning now.");
  });

  it("falls back to the standard reminder text when the reply has no JSON", async () => {
    await q("DELETE FROM public.purchase_reminder_messages WHERE message_date = $1::date", [today]);
    stubReply = "plain words only";
    await run();
    const [row] = await q("SELECT subject_line, message_body FROM public.purchase_reminder_messages WHERE message_date = $1::date", [today]);
    assert.equal(row.message_body, "plain words only");
    assert.match(row.subject_line, /courses are waiting/i);
  });

  it("emails a non-enrolled account that has not had today's reminder, and logs it", async () => {
    await q("DELETE FROM public.purchase_reminder_messages WHERE message_date = $1::date", [today]);
    await q("DELETE FROM public.purchase_reminder_email_logs WHERE sent_date = $1::date", [today]);
    stubReply = '{"subject_line": "Just you", "message_body": "Explore now."}';
    await markAllReminded();

    // A brand-new account has no enrolments and no log for today: it is the only one to email.
    const target = await makeUser();
    const before = sentMessages.length;
    const r = await run();
    assert.equal(r.status, 200);
    assert.equal(r.body.message, "Purchase reminder emails processed");
    assert.equal(r.body.sent, 1);
    assert.equal(r.body.failed, 0);
    assert.equal(r.body.total, 1);
    assert.equal(r.body.subject, "Just you");

    const mail = sentMessages.slice(before);
    assert.equal(mail.length, 1);
    assert.equal(mail[0].to, target.email);
    const [log] = await q("SELECT status FROM public.purchase_reminder_email_logs WHERE user_id = $1 AND sent_date = $2::date", [target.id, today]);
    assert.equal(log.status, "sent");
  });
});
