import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import crypto from "node:crypto";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { router } from "../functions/razorpay-webhook/index.js";

// Only the signature check and the payment state machine are exercised. No Razorpay call is made.
const SECRET = "test-webhook-secret";
let fnServer;
let fnBase;
const savedSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
const paymentIds = [];
const courseIds = [];
const userIds = [];

function sign(raw, secret = SECRET) {
  return crypto.createHmac("sha256", secret).update(raw).digest("hex");
}

async function send(payloadObj, { signature, raw, method = "POST" } = {}) {
  const body = raw ?? JSON.stringify(payloadObj);
  const headers = { "Content-Type": "application/json" };
  if (signature !== undefined) headers["x-razorpay-signature"] = signature;
  else headers["x-razorpay-signature"] = sign(body);
  const res = await fetch(`${fnBase}/`, { method, headers, body: method === "GET" ? undefined : body });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

const capturedEvent = (orderId, paymentId) => ({
  event: "payment.captured",
  payload: { payment: { entity: { id: paymentId, order_id: orderId } } },
});

async function makePayment(status = "pending") {
  const user = await makeUser();
  userIds.push(user.id);
  const orderId = "order_" + randomUUID().slice(0, 18);
  const id = randomUUID();
  paymentIds.push(id);
  await q(
    `INSERT INTO public.payments (id, user_id, order_id, gateway_order_id, amount_inr, final_amount, status)
     VALUES ($1, $2, $3, $3, 100, 100, $4)`,
    [id, user.id, orderId, status]
  );
  const courseId = randomUUID();
  courseIds.push(courseId);
  await q("INSERT INTO public.courses (id, name, slug) VALUES ($1, 'Webhook course', $2)", [courseId, `wh-${courseId}`]);
  await q("INSERT INTO public.order_items (payment_id, course_id, price_inr) VALUES ($1, $2, 100)", [id, courseId]);
  return { id, user, orderId, courseId };
}

describe("razorpay-webhook", () => {
  before(async () => {
    await startServer();
    process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;
    const app = express();
    app.use("/", router); // mounted before any JSON parser, as the route requires
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
      if (savedSecret === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET;
      else process.env.RAZORPAY_WEBHOOK_SECRET = savedSecret;
      await new Promise((r) => fnServer.close(r));
      await stopServer();
    }
  });

  it("rejects non-POST methods", async () => {
    const r = await send({}, { method: "GET" });
    assert.equal(r.status, 405);
  });

  it("refuses to run without a configured secret", async () => {
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    try {
      const r = await send(capturedEvent("order_x", "pay_x"));
      assert.equal(r.status, 500);
    } finally {
      process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;
    }
  });

  it("rejects a missing signature", async () => {
    const r = await send(capturedEvent("order_x", "pay_x"), { signature: "" });
    assert.equal(r.status, 400);
    assert.equal(r.body, "Missing signature");
  });

  it("rejects a signature made with the wrong secret", async () => {
    const body = JSON.stringify(capturedEvent("order_x", "pay_x"));
    const r = await send(null, { raw: body, signature: sign(body, "other-secret") });
    assert.equal(r.status, 400);
    assert.equal(r.body, "Invalid signature");
  });

  it("rejects a valid signature over a body that was changed afterwards", async () => {
    const original = JSON.stringify(capturedEvent("order_x", "pay_x"));
    const tampered = JSON.stringify(capturedEvent("order_x", "pay_HACKED"));
    const r = await send(null, { raw: tampered, signature: sign(original) });
    assert.equal(r.status, 400);
  });

  it("acknowledges other events without touching payments", async () => {
    const r = await send({ event: "refund.created" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { status: "ignored", event: "refund.created" });
  });

  it("rejects a payment.captured event with no payment entity", async () => {
    const r = await send({ event: "payment.captured", payload: {} });
    assert.equal(r.status, 400);
    assert.equal(r.body, "Invalid payload");
  });

  it("returns not_found (200, so Razorpay does not retry) for an unknown order", async () => {
    const r = await send(capturedEvent("order_does_not_exist", "pay_1"));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { status: "not_found" });
  });

  it("marks a pending payment successful and enrols the buyer", async () => {
    const p = await makePayment("pending");
    const r = await send(capturedEvent(p.orderId, "pay_ok_1"));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { status: "processed" });

    const [pay] = await q("SELECT status, gateway_payment_id, completed_at FROM public.payments WHERE id = $1", [p.id]);
    assert.equal(pay.status, "success");
    assert.equal(pay.gateway_payment_id, "pay_ok_1");
    assert.ok(pay.completed_at);

    const [en] = await q("SELECT is_active, expires_at FROM public.enrollments WHERE student_id = $1 AND course_id = $2", [p.user.id, p.courseId]);
    assert.equal(en.is_active, true);
    assert.ok(new Date(en.expires_at).getTime() > Date.now() + 300 * 24 * 3600 * 1000);
  });

  it("a repeated delivery is reported as already_processed and changes nothing", async () => {
    const p = await makePayment("pending");
    await send(capturedEvent(p.orderId, "pay_dup_1"));
    const again = await send(capturedEvent(p.orderId, "pay_dup_2"));
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, { status: "already_processed" });
    const [pay] = await q("SELECT gateway_payment_id FROM public.payments WHERE id = $1", [p.id]);
    assert.equal(pay.gateway_payment_id, "pay_dup_1");
  });

  it("does not reprocess a payment that is already failed or refunded", async () => {
    const p = await makePayment("failed");
    const r = await send(capturedEvent(p.orderId, "pay_late_1"));
    assert.deepEqual(r.body, { status: "already_processed" });
    const [pay] = await q("SELECT status FROM public.payments WHERE id = $1", [p.id]);
    assert.equal(pay.status, "failed");
  });
});
