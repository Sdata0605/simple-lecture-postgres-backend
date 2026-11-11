import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { mountRouter, request, bearer, stubFetch, uniqueTag } from "./group02-harness.js";
import { router, hooks } from "../functions/create-payment-order/index.js";

describe("create-payment-order", () => {
  let app;
  let user;
  let courseId;
  const orderIds = [];
  const codes = [];
  const saved = { id: process.env.RAZORPAY_KEY_ID, secret: process.env.RAZORPAY_KEY_SECRET, base: process.env.RAZORPAY_API_BASE };
  before(async () => {
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    await startServer();
    app = await mountRouter("/functions/v1/create-payment-order", router);
    user = await makeUser();
    [{ id: courseId }] = await q("SELECT id FROM public.courses LIMIT 1");
  });
  after(async () => {
    hooks.fetch = null;
    for (const [k, v] of Object.entries({ RAZORPAY_KEY_ID: saved.id, RAZORPAY_KEY_SECRET: saved.secret, RAZORPAY_API_BASE: saved.base })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const oid of orderIds) {
      await q("DELETE FROM public.order_items WHERE payment_id IN (SELECT id FROM public.payments WHERE order_id = $1)", [oid]);
      await q("DELETE FROM public.payments WHERE order_id = $1", [oid]);
    }
    for (const c of codes) await q("DELETE FROM public.discount_codes WHERE code = $1", [c]);
    await app.close();
    await stopServer();
  });

  const body = (extra = {}) => ({
    amount: 1000,
    courses: [{ id: courseId, price: 1000 }],
    userId: user.id,
    customerInfo: { fullName: "A B", email: "x@example.test", phone: "9000000000" },
    ...extra,
  });

  it("requires a token that belongs to the user in the body", async () => {
    assert.equal((await request(app.base, { body: body() })).status, 401);
    const other = await makeUser();
    assert.equal((await request(app.base, { body: body(), headers: bearer(other.access) })).status, 403);
  });

  it("requires userId and at least one course", async () => {
    const r = await request(app.base, { body: body({ courses: [] }), headers: bearer(user.access) });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "Missing required fields");
  });

  it("creates a pending payment and its items without a Razorpay order when keys are unset", async () => {
    const r = await request(app.base, { body: body(), headers: bearer(user.access) });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "created");
    assert.equal(r.body.amount, 1000);
    assert.equal(r.body.razorpayOrderId, null);
    orderIds.push(r.body.orderId);
    const [pay] = await q("SELECT status, final_amount, user_id FROM public.payments WHERE id = $1", [r.body.paymentId]);
    assert.equal(pay.status, "pending");
    assert.equal(pay.final_amount, 1000);
    assert.equal(pay.user_id, user.id);
    const items = await q("SELECT course_id FROM public.order_items WHERE payment_id = $1", [r.body.paymentId]);
    assert.equal(items.length, 1);
  });

  it("applies a percentage promo code and counts its use", async () => {
    const code = uniqueTag("PROMO").toUpperCase();
    codes.push(code);
    await q("INSERT INTO public.discount_codes (code, discount_percent, is_active, times_used) VALUES ($1, 10, true, 0)", [code]);
    const r = await request(app.base, { body: body({ promoCode: code.toLowerCase() }), headers: bearer(user.access) });
    assert.equal(r.status, 200);
    assert.equal(r.body.amount, 900);
    orderIds.push(r.body.orderId);
    const [dc] = await q("SELECT times_used FROM public.discount_codes WHERE code = $1", [code]);
    assert.equal(dc.times_used, 1);
  });

  it("creates the Razorpay order through the configured API when keys are set", async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_key";
    process.env.RAZORPAY_KEY_SECRET = "rzp_test_secret";
    process.env.RAZORPAY_API_BASE = "http://razorpay.test";
    hooks.fetch = stubFetch(200, { id: "order_test_123" });
    const r = await request(app.base, { body: body(), headers: bearer(user.access) });
    assert.equal(r.status, 200);
    assert.equal(r.body.razorpayOrderId, "order_test_123");
    assert.equal(r.body.razorpayKeyId, "rzp_test_key");
    orderIds.push(r.body.orderId);
    const call = hooks.fetch.calls[0];
    assert.equal(call.url, "http://razorpay.test/v1/orders");
    assert.equal(JSON.parse(call.init.body).amount, 100000);
  });
});
