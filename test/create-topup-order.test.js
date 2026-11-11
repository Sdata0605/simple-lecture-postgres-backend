import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, stopServer, makeUser, q } from "./helpers.js";
import { mountRouter, request, bearer, stubFetch, uniqueTag } from "./group02-harness.js";
import { router, hooks } from "../functions/create-topup-order/index.js";

describe("create-topup-order", () => {
  let app;
  let user;
  let courseId;
  const saved = { id: process.env.RAZORPAY_KEY_ID, secret: process.env.RAZORPAY_KEY_SECRET, base: process.env.RAZORPAY_API_BASE };
  before(async () => {
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    await startServer();
    app = await mountRouter("/functions/v1/create-topup-order", router);
    user = await makeUser();
    [{ id: courseId }] = await q("SELECT id FROM public.courses LIMIT 1");
  });
  after(async () => {
    hooks.fetch = null;
    for (const [k, v] of Object.entries({ RAZORPAY_KEY_ID: saved.id, RAZORPAY_KEY_SECRET: saved.secret, RAZORPAY_API_BASE: saved.base })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await q("DELETE FROM public.language_topup_purchases WHERE user_id = $1", [user.id]);
    await app.close();
    await stopServer();
  });

  it("requires a token that belongs to the user", async () => {
    const payload = { userId: user.id, courseId, languages: ["hi"] };
    assert.equal((await request(app.base, { body: payload })).status, 401);
    const other = await makeUser();
    assert.equal((await request(app.base, { body: payload, headers: bearer(other.access) })).status, 403);
  });

  it("validates the request fields", async () => {
    const r = await request(app.base, { body: { userId: user.id, courseId, languages: [] }, headers: bearer(user.access) });
    assert.equal(r.status, 400);
  });

  it("returns 404 for an unknown course", async () => {
    const r = await request(app.base, {
      body: { userId: user.id, courseId: "00000000-0000-4000-8000-000000000000", languages: ["hi"] },
      headers: bearer(user.access),
    });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "Course not found");
  });

  it("refuses to create an order when the payment gateway is not configured", async () => {
    const r = await request(app.base, { body: { userId: user.id, courseId, languages: ["hi"] }, headers: bearer(user.access) });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "Payment gateway not configured");
  });

  it("skips languages already bought and creates a pending purchase for the rest", async () => {
    const other = await makeUser();
    await q(
      `INSERT INTO public.language_topup_purchases (user_id, course_id, order_id, selected_languages, amount_paid, status)
       VALUES ($1, $2, $3, '["hi"]'::jsonb, 0, 'success')`,
      [other.id, courseId, uniqueTag("TOPUP-OLD")]
    );
    try {
      const allOwned = await request(app.base, { body: { userId: other.id, courseId, languages: ["hi"] }, headers: bearer(other.access) });
      assert.equal(allOwned.status, 400);
      assert.equal(allOwned.body.error, "All selected languages are already purchased");
    } finally {
      await q("DELETE FROM public.language_topup_purchases WHERE user_id = $1", [other.id]);
    }

    process.env.RAZORPAY_KEY_ID = "rzp_test_key";
    process.env.RAZORPAY_KEY_SECRET = "rzp_test_secret";
    process.env.RAZORPAY_API_BASE = "http://razorpay.test";
    hooks.fetch = stubFetch(200, { id: "order_topup_9" });
    const r = await request(app.base, { body: { userId: user.id, courseId, languages: ["hi", "ta"] }, headers: bearer(user.access) });
    assert.equal(r.status, 200);
    assert.equal(r.body.razorpayOrderId, "order_topup_9");
    assert.deepEqual(r.body.languages, ["hi", "ta"]);
    const [row] = await q("SELECT status, selected_languages FROM public.language_topup_purchases WHERE order_id = $1", [r.body.orderId]);
    assert.equal(row.status, "pending");
    assert.deepEqual(row.selected_languages, ["hi", "ta"]);
  });
});
