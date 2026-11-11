// Serves ONE function's router on its own local port, so a function's tests can run before
// the lead mounts it in src/app.js. The router is mounted at "/", so tests call "/" (plus any query).
import express from "express";
import http from "node:http";
import { once } from "node:events";

export async function serveRouter(router) {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use("/", router);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;

  async function send(method, path, { body, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
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

  return {
    base,
    post: (body, headers) => send("POST", "/", { body, headers }),
    get: (query, headers) => send("GET", `/${query}`, { headers }),
    close: () => new Promise((r) => server.close(r)),
  };
}

// A local fake upstream service (for proxy functions). handler(req, body) returns { status, type, body }.
// Every request is recorded in `seen`, so tests can check what was forwarded. Nothing leaves localhost.
export async function startUpstream(handler) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    const out = handler(req, body);
    res.writeHead(out.status ?? 200, { "Content-Type": out.type ?? "application/json" });
    res.end(out.body ?? "{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => new Promise((r) => server.close(r)),
  };
}

// Sets env vars for one test and returns a function that restores them.
export function setEnv(vars) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}
