// Test harness for the group-00 ports. Mounts ONE router on a private express app, so a test can
// exercise a function before the lead adds it to src/app.js. Uses the same JSON parsing as the app.
import { once } from "node:events";
import express from "express";
import { pool } from "../functions/_shared/db.js";

export async function mountRouter(mountPath, router) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(mountPath, router);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, { body, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  };

  return {
    call,
    post: (path, body, headers) => call("POST", path, { body, headers }),
    close: () => new Promise((r) => server.close(r)),
  };
}

export async function closeDb() {
  await pool.end();
}
