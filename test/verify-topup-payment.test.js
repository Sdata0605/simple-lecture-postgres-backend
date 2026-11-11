import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import crypto from "node:crypto";
import express from "express";
import { q, uniqueEmail } from "./helpers.js";
import { pool } from "../functions/_shared/db.js";
import { createAuthUser } from "../functions/_shared/accounts.js";
import { router } from "../functions/verify-topup-payment/index.js";

const SECRET = "test-razorpay-secret-not-real";
let server;
let base;
let user;
let courseId;
const tag = `tp5${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const orderA = `order_a_${tag}`;
const orderB = `order_b_${tag}`;
const sign = (rzOrder, payment) => crypto.createHmac("sha256", SECRET).update(`${rzOrder}|${payment}`).digest("hex");

const post = async (body) => {
  const r = await fetch(`${base}/functions/v1/verify-topup-payment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

describe("verify-topup-payment", () => {
  before(async () => {
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    const app = express();
    app.use(express.json());
    app.use("/functions/v1/verify-topup-payment", router);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${server.address().port}`;

    user = await createAuthUser({ email: uniqueEmail("topup"), password: "Pass!word1", fullName: "Topup Test" });
    [{ id: courseId }] = await q("INSERT INTO public.courses (name, slug) VALUES ($1, $2) RETURNING id", [
      `Topup ${tag}`,
      `topup-${tag}`.toLowerCase(),
    ]);
    await q(
      `INSERT INTO public.language_topup_purchases (user_id, course_id, order_id, selected_languages, status)
       VALUES ($1, $2, $3, '["hi-IN"]'::jsonb, 'pending')`,
      [user.id, courseId, orderA]
    );
  });

  after(async () => {
    await q("DELETE FROM public.language_topup_purchases WHERE course_id = $1", [courseId]);
    await q("DELETE FROM public.courses WHERE id = $1", [courseId]);
    await q("DELETE FROM public.user_roles WHERE user_id = $1", [user.id]);
    await q("DELETE FROM public.profiles WHERE id = $1", [user.id]);
    await q("DELETE FROM auth.users WHERE id = $1", [user.id]);
    await new Promise((r) => server.close(r));
    await pool.end();
  });

  it("requires every field", async () => {
    const r = await post({ razorpay_order_id: "o" });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: "Missing required fields" });
  });

  it("returns 500 when the gateway secret is missing", async () => {
    const saved = process.env.RAZORPAY_KEY_SECRET;
    delete process.env.RAZORPAY_KEY_SECRET;
    try {
      const r = await post({ razorpay_order_id: "o", razorpay_payment_id: "p", razorpay_signature: "s", orderId: orderA });
      assert.equal(r.status, 500);
      assert.deepEqual(r.body, { error: "Payment gateway not configured" });
    } finally {
      process.env.RAZORPAY_KEY_SECRET = saved;
    }
  });

  it("rejects a bad signature with 400", async () => {
    const r = await post({ razorpay_order_id: "o", razorpay_payment_id: "p", razorpay_signature: "bad", orderId: orderA });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: "Payment verification failed" });
  });

  it("unlocks the purchased languages on a valid signature", async () => {
    const r = await post({
      razorpay_order_id: "rz_o", razorpay_payment_id: "rz_p", razorpay_signature: sign("rz_o", "rz_p"),
      orderId: orderA, userId: user.id, courseId, languages: ["hi-IN"],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    const [row] = await q("SELECT status, razorpay_payment_id FROM public.language_topup_purchases WHERE order_id = $1", [orderA]);
    assert.equal(row.status, "success");
    assert.equal(row.razorpay_payment_id, "rz_p");
  });

  it("succeeds with no pending row, as the original did", async () => {
    const r = await post({
      razorpay_order_id: "rz_o2", razorpay_payment_id: "rz_p2", razorpay_signature: sign("rz_o2", "rz_p2"),
      orderId: `none_${tag}`, userId: user.id, courseId, languages: ["ta-IN"],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
  });
});
