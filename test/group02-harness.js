// Test harness for the group-02 ports. src/app.js does not mount these routers yet, so each test
// mounts its router on a small express app of its own. Users and DB access still come from helpers.js.
import express from "express";
import { once } from "node:events";
import { makeUser, q } from "./helpers.js";

// Mounts `router` at `mountPath` on a random local port. Returns { base, close }.
export async function mountRouter(mountPath, router) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(mountPath, router);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    base: `http://127.0.0.1:${server.address().port}${mountPath}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

// Sends one request. Returns { status, body, headers } where body is parsed JSON when possible.
export async function request(url, { method = "POST", body, headers = {}, raw } = {}) {
  const res = await fetch(url, {
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
  return { status: res.status, body: json, headers: res.headers };
}

export const bearer = (token) => ({ Authorization: `Bearer ${token}` });

// A signed-in user with the admin role (the role row is removed by cleanupAdmin).
export async function makeAdmin() {
  const u = await makeUser();
  await q("INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin') ON CONFLICT (user_id, role) DO NOTHING", [u.id]);
  return u;
}

// A stub fetch that answers every call with the given JSON body and status, and records the calls.
export function stubFetch(status, payload) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    return new Response(text, { status, headers: { "Content-Type": "application/json" } });
  };
  fn.calls = calls;
  return fn;
}

export const uniqueTag = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
