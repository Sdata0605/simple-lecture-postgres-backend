// Mounts one function router on its own local express app, so its tests run even before the
// lead adds it to src/app.js. Only 127.0.0.1 is used. Also gives a tiny request helper.
import express from "express";
import { once } from "node:events";

export async function serveRouter(mountPath, router, { raw = false } = {}) {
  const app = express();
  if (!raw) app.use(express.json({ limit: "1mb" }));
  app.use(mountPath, router);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

export async function hitAt(base, method, path, { body, headers = {}, raw } = {}) {
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
  return { status: res.status, body: json, headers: res.headers };
}
