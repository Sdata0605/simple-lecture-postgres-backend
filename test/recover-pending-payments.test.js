import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { router } from "../functions/recover-pending-payments/index.js";

// Razorpay is replaced by a local stub (RAZORPAY_API_BASE). No real host is contacted.
const CRON = "test-cron-secret";
let stub;
let fnServer;
let fnBase;
const savedEnv = {};
const ENV_KEYS = ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_API_BASE", "CRON_SECRET"];
const paymentIds = [];
const courseIds = [];
const userIds = [];

// Reply chosen from the order id in the URL.
function stubReply(url) {
  if (url.includes("order_rp_cap")) return { status: 200, body: { items: [{ id: "pay_rp_1", status: "captured" }] } };
  if (url.includes("order_rp_none")) return { status: 200, body: { items: [{ id: "pay_rp_2", status: "failed" }] } };
  if (url.includes("order_rp_err")) return { status: 500, body: { error: "down" } };
  return { status: 200, body: { items: [] } };
}

async function makeOldPending(orderTag) {
  const user = await makeUser();
  userIds.push(user.id);
  const orderId = `order_${orderTag}_${randomUUID().slice(0, 8)}`;
  const id = randomUUID();
  paymentIds.push(id);
  await q(
    `INSERT INTO public.payments (id, user_id, order_id, gateway_order_id, amount_inr, final_amount, status, created_at)
     VALUES ($1, $2, $3, $3, 100, 100, 'pending', (now() AT TIME ZONE 'UTC') - interval '30 minutes')`,
    [id, user.id, orderId]
  );
  const courseId = randomUUID();
  courseIds.push(courseId);
  await q("INSERT INTO public.courses (id, name, slug) VALUES ($1, 'Recovery course', $2)", [courseId, `rc-${courseId}`]);
  await q("INSERT INTO public.order_items (payment_id, course_id, price_inr) VALUES ($1, $2, 100)", [id, courseId]);
  return { id, user, orderId, courseId };
}

async function run(headers = { Authorization: `Bearer ${CRON}` }) {
  const res = await fetch(`${fnBase}/`, { method: "POST", headers });
  return { status: res.status, body: await res.json() };
}

describe("recover-pending-payments", () => {
  before(async () => {
    await startServer();
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

    stub = http.createServer((req, res) => {
      const reply = stubReply(req.url);
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
    stub.listen(0, "127.0.0.1");
    await once(stub, "listening");
    process.env.RAZORPAY_API_BASE = `http://127.0.0.1:${stub.address().port}/v1`;
    process.env.RAZORPAY_KEY_ID = "test-key-id";
    process.env.RAZORPAY_KEY_SECRET = "test-key-secret";
    process.env.CRON_SECRET = CRON;

    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/", router);
    fnServer = app.listen(0, "127.0.0.1");
    await once(fnServer, "listening");
    fnBase = `http://127.0.0.1:${fnServer.address().port}`;
  });

  after(async () => {
    try {
      if (paymentIds.length) {
        await q("DELETE FROM public.enrollments WHERE course_id = ANY($1)", [courseIds]);
        await q("DELETE FROM public.order_items WHERE payment_id = ANY($1)", [paymentIds]);
        await q("DELETE FROM public.payments WHERE id = ANY($1)", [paymentIds]);
        await q("DELETE FROM public.courses WHERE id = ANY($1)", [courseIds]);
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
    assert.equal((await run({ Authorization: "Bearer wrong" })).status, 401);
  });

  it("refuses to run without Razorpay credentials", async () => {
    const saved = process.env.RAZORPAY_KEY_SECRET;
    delete process.env.RAZORPAY_KEY_SECRET;
    try {
      const r = await run();
      assert.equal(r.status, 500);
      assert.equal(r.body.error, "Razorpay credentials not configured");
    } finally {
      process.env.RAZORPAY_KEY_SECRET = saved;
    }
  });

  it("recovers a payment Razorpay reports as captured, and enrols the buyer", async () => {
    const p = await makeOldPending("rp_cap");
    const r = await run();
    assert.equal(r.status, 200);
    const mine = r.body.results.find((x) => x.order_id === p.orderId);
    assert.deepEqual(mine, { order_id: p.orderId, status: "recovered", razorpay_id: "pay_rp_1" });

    const [pay] = await q("SELECT status, gateway_payment_id FROM public.payments WHERE id = $1", [p.id]);
    assert.equal(pay.status, "success");
    assert.equal(pay.gateway_payment_id, "pay_rp_1");
    const en = await q("SELECT is_active FROM public.enrollments WHERE student_id = $1 AND course_id = $2", [p.user.id, p.courseId]);
    assert.equal(en.length, 1);
    assert.equal(en[0].is_active, true);
  });

  it("leaves a payment alone when Razorpay has no captured charge", async () => {
    const p = await makeOldPending("rp_none");
    await run();
    const [pay] = await q("SELECT status FROM public.payments WHERE id = $1", [p.id]);
    assert.equal(pay.status, "pending");
  });

  it("reports a Razorpay HTTP error for that order and carries on", async () => {
    const p = await makeOldPending("rp_err");
    const r = await run();
    assert.equal(r.status, 200);
    const mine = r.body.results.find((x) => x.order_id === p.orderId);
    assert.deepEqual(mine, { order_id: p.orderId, status: "razorpay_error", code: 500 });
  });

  it("ignores payments younger than 15 minutes", async () => {
    const user = await makeUser();
    userIds.push(user.id);
    const orderId = `order_rp_young_${randomUUID().slice(0, 8)}`;
    const id = randomUUID();
    paymentIds.push(id);
    await q(
      `INSERT INTO public.payments (id, user_id, order_id, gateway_order_id, amount_inr, final_amount, status, created_at)
       VALUES ($1, $2, $3, $3, 100, 100, 'pending', now() AT TIME ZONE 'UTC')`,
      [id, user.id, orderId]
    );
    const r = await run();
    assert.equal(r.body.results.some((x) => x.order_id === orderId), false);
  });
});
