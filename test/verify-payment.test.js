import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import crypto from "node:crypto";
import express from "express";
import { q, uniqueEmail } from "./helpers.js";
import { pool } from "../functions/_shared/db.js";
import { createAuthUser } from "../functions/_shared/accounts.js";
import { router } from "../functions/verify-payment/index.js";

const SECRET = "test-razorpay-secret-not-real";
let server;
let base;
let user;
let courseId;
const tag = `v5${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const orderId = `order_${tag}`;
const sign = (orderIdRz, paymentId) =>
  crypto.createHmac("sha256", SECRET).update(`${orderIdRz}|${paymentId}`).digest("hex");

const post = async (body) => {
  const r = await fetch(`${base}/functions/v1/verify-payment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

describe("verify-payment", () => {
  before(async () => {
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    const app = express();
    app.use(express.json());
    app.use("/functions/v1/verify-payment", router);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;

    user = await createAuthUser({ email: uniqueEmail("pay"), password: "Pass!word1", fullName: "Pay Test" });
    [{ id: courseId }] = await q("INSERT INTO public.courses (name, slug) VALUES ($1, $2) RETURNING id", [
      `Pay ${tag}`,
      `pay-${tag}`.toLowerCase(),
    ]);
    await q("INSERT INTO public.payments (user_id, order_id, amount_inr, final_amount, status) VALUES ($1, $2, 100, 100, 'pending')", [
      user.id,
      orderId,
    ]);
  });

  after(async () => {
    await q("DELETE FROM public.enrollments WHERE course_id = $1", [courseId]);
    await q("DELETE FROM public.payments WHERE order_id = $1", [orderId]);
    await q("DELETE FROM public.courses WHERE id = $1", [courseId]);
    await q("DELETE FROM public.user_roles WHERE user_id = $1", [user.id]);
    await q("DELETE FROM public.profiles WHERE id = $1", [user.id]);
    await q("DELETE FROM auth.users WHERE id = $1", [user.id]);
    await new Promise((r) => server.close(r));
    await pool.end();
  });

  it("returns 500 when the Razorpay secret is not configured", async () => {
    const saved = process.env.RAZORPAY_KEY_SECRET;
    delete process.env.RAZORPAY_KEY_SECRET;
    try {
      const r = await post({ razorpay_order_id: "o", razorpay_payment_id: "p", razorpay_signature: "x", orderId });
      assert.equal(r.status, 500);
      assert.equal(r.body.verified, false);
      assert.equal(r.body.error, "Razorpay secret not configured");
    } finally {
      process.env.RAZORPAY_KEY_SECRET = saved;
    }
  });

  it("rejects a wrong signature with 400 and changes nothing", async () => {
    const r = await post({
      razorpay_order_id: "order_rz", razorpay_payment_id: "pay_rz", razorpay_signature: "deadbeef",
      orderId, userId: user.id, courses: [{ id: courseId }],
    });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: "Payment verification failed", verified: false });
    const [p] = await q("SELECT status FROM public.payments WHERE order_id = $1", [orderId]);
    assert.equal(p.status, "pending");
  });

  it("marks the payment successful and enrolls the student on a valid signature", async () => {
    const r = await post({
      razorpay_order_id: "order_rz", razorpay_payment_id: "pay_rz", razorpay_signature: sign("order_rz", "pay_rz"),
      orderId, userId: user.id, courses: [{ id: courseId }],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.verified, true);
    const [p] = await q("SELECT status, gateway_payment_id FROM public.payments WHERE order_id = $1", [orderId]);
    assert.equal(p.status, "success");
    assert.equal(p.gateway_payment_id, "pay_rz");
    const [e] = await q("SELECT is_active FROM public.enrollments WHERE student_id = $1 AND course_id = $2", [user.id, courseId]);
    assert.equal(e.is_active, true);
  });
});
