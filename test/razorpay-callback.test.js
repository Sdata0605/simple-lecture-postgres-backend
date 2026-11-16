import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import crypto from "node:crypto";
import express from "express";
import { q, uniqueEmail } from "./helpers.js";
import { pool } from "../functions/_shared/db.js";
import { createAuthUser } from "../functions/_shared/accounts.js";
import { router, hooks } from "../functions/razorpay-callback/index.js";

const SECRET = "test-razorpay-secret-not-real";
const tag = `cb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const rzOrder = `order_${tag}`;
const orderId = `ORD_${tag}`;
let server;
let base;
let user;
let courseId;
let paymentId;

const sign = (o, p) => crypto.createHmac("sha256", SECRET).update(`${o}|${p}`).digest("hex");

// Do not follow redirects: we only check where the browser would be sent.
const get = (path) => fetch(`${base}${path}`, { redirect: "manual" });

describe("razorpay-callback", () => {
  before(async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_callback";
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    const app = express();
    app.use("/functions/v1/razorpay-callback", router);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;

    user = await createAuthUser({ email: uniqueEmail("cb"), password: "Pass!word1", fullName: "Callback Test" });
    [{ id: courseId }] = await q("INSERT INTO public.courses (name, slug, price_inr) VALUES ($1, $2, 2950) RETURNING id", [
      `CB ${tag}`,
      `cb-${tag}`.toLowerCase(),
    ]);
    const [p] = await q(
      "INSERT INTO public.payments (user_id, order_id, amount_inr, final_amount, status, gateway_order_id) VALUES ($1, $2, 2950, 2950, 'pending', $3) RETURNING id",
      [user.id, orderId, rzOrder]
    );
    paymentId = p.id;
    await q("INSERT INTO public.order_items (payment_id, course_id, price_inr) VALUES ($1, $2, 2950)", [paymentId, courseId]);
  });

  after(async () => {
    hooks.fetch = null;
    await q("DELETE FROM public.enrollments WHERE course_id = $1", [courseId]);
    await q("DELETE FROM public.payments WHERE order_id = $1", [orderId]);
    await q("DELETE FROM public.courses WHERE id = $1", [courseId]);
    await q("DELETE FROM public.user_roles WHERE user_id = $1", [user.id]);
    await q("DELETE FROM public.profiles WHERE id = $1", [user.id]);
    await q("DELETE FROM auth.users WHERE id = $1", [user.id]);
    await new Promise((r) => server.close(r));
    await pool.end();
  });

  it("redirects to payment-failed on a bad signature and changes nothing", async () => {
    const r = await get(`/functions/v1/razorpay-callback?razorpay_order_id=${rzOrder}&razorpay_payment_id=pay_x&razorpay_signature=bad`);
    assert.equal(r.status, 303);
    assert.match(r.headers.get("location"), /\/payment-failed\?orderId=/);
    const [p] = await q("SELECT status FROM public.payments WHERE id = $1", [paymentId]);
    assert.equal(p.status, "pending");
  });

  it("verifies with Razorpay, marks success and enrols from the stored order items", async () => {
    hooks.fetch = async () =>
      new Response(JSON.stringify({ id: "pay_ok", order_id: rzOrder, status: "captured", currency: "INR", amount: 295000 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const r = await get(
      `/functions/v1/razorpay-callback?razorpay_order_id=${rzOrder}&razorpay_payment_id=pay_ok&razorpay_signature=${sign(rzOrder, "pay_ok")}`
    );
    assert.equal(r.status, 303);
    assert.match(r.headers.get("location"), /\/payment-success\?orderId=/);
    const [p] = await q("SELECT status, gateway_payment_id FROM public.payments WHERE id = $1", [paymentId]);
    assert.equal(p.status, "success");
    assert.equal(p.gateway_payment_id, "pay_ok");
    const [e] = await q("SELECT is_active FROM public.enrollments WHERE student_id = $1 AND course_id = $2", [user.id, courseId]);
    assert.equal(e.is_active, true);
    hooks.fetch = null;
  });

  it("refuses an unknown return origin and uses the default instead", async () => {
    const r = await get(`/functions/v1/razorpay-callback?return=https://evil.example&razorpay_order_id=${rzOrder}`);
    assert.equal(r.status, 303);
    assert.ok(r.headers.get("location").startsWith("https://simplelecture.com/payment-failed"));
  });
});
