import "dotenv/config";
// Tests must never send real messages, whatever the .env says.
process.env.MAIL_MODE = "dry-run";
process.env.MESSAGE_MODE = "dry-run";
import { once } from "node:events";
import jwt from "jsonwebtoken";
import { createApp } from "../src/app.js";
import { attachRealtime, stopRealtime } from "../functions/realtime/index.js";
import { pool } from "../functions/_shared/db.js";
import { sentMessages } from "../functions/_shared/mail.js";
import { sentSms } from "../functions/_shared/sms.js";

// Safety: these tests write data. They must never run against the server database.
if (!/simplelecture_test/.test(process.env.DATABASE_URL || "")) {
  throw new Error("Refusing to run tests: DATABASE_URL must point at simplelecture_test");
}

let server;
export let base;
export async function startServer() {
  if (server) return base;
  server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");
  attachRealtime(server);
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}
export async function stopServer() {
  if (!server) return;
  await stopRealtime();
  await new Promise((r) => server.close(r));
  server = undefined;
  await pool.end();
}

export async function call(method, path, { body, headers = {}, raw } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: raw !== undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}
export const post = (path, body, headers) => call("POST", path, { body, headers });

export const uniqueEmail = (tag = "t") =>
  `${tag}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.test`;
export const uniquePhone = () => "9" + String(Math.floor(100000000 + Math.random() * 899999999));

// Latest 6-digit code sent to an email (dry-run mail) since startup.
export function emailCode(to) {
  const msg = [...sentMessages].reverse().find((m) => m.to === to);
  const m = msg && /(\d{6})/.exec(msg.text || "");
  return m ? m[1] : null;
}
// Latest SMS/WhatsApp code sent to a 10-digit phone (dry-run).
export function phoneCode(phone10) {
  const msg = [...sentSms].reverse().find((m) => m.to === `91${phone10}`);
  return msg ? msg.otp : null;
}

export async function q(sql, params = []) {
  return (await pool.query(sql, params)).rows;
}

// Creates a confirmed auth user through the real signup route.
export async function makeUser({ phone = uniquePhone(), name = "Test User", password = "Pass!word1" } = {}) {
  const email = uniqueEmail("user");
  const r = await post("/auth/v1/signup", { email, password, data: { full_name: name, phone } });
  if (r.status !== 200) throw new Error(`makeUser failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { id: r.body.user.id, email, password, phone, access: r.body.access_token, refresh: r.body.refresh_token };
}

export function expiredJwt(sub) {
  return jwt.sign({ sub, role: "authenticated", aud: "authenticated", exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET);
}
