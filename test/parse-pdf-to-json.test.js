import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { once } from "node:events";
import { startServer, stopServer, q } from "./helpers.js";
import { router } from "../functions/parse-pdf-to-json/index.js";

// Datalab and Backblaze are replaced by one local stub server. No real host is contacted.
const KEY = "test-datalab-key";
const keysSeen = [];
let stub;
let stubBase;
let fnServer;
let fnBase;
const ENV_KEYS = ["DATALAB_API_KEY", "DATALAB_API_BASE", "B2_API_BASE", "B2_KEY_ID", "B2_APPLICATION_KEY", "B2_BUCKET_ID"];
const savedEnv = {};
const IMG_B64 = Buffer.from("fake-png-bytes").toString("base64");
const imageRequestIds = [];

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function stubHandler(req, res) {
  readBody(req).then((body) => {
    const send = (status, obj) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const url = req.url;
    keysSeen.push(req.headers["x-api-key"]);
    if (url === "/b2api/v2/b2_authorize_account") {
      return send(200, { authorizationToken: "auth-tok", apiUrl: stubBase, downloadUrl: stubBase });
    }
    if (url === "/b2api/v2/b2_get_download_authorization") {
      return send(200, { authorizationToken: "dl-tok" });
    }
    if (url === "/b2api/v2/b2_get_upload_url") {
      return send(200, { uploadUrl: `${stubBase}/upload`, authorizationToken: "up-tok" });
    }
    if (url === "/upload") {
      return send(200, { fileId: "file-1" });
    }
    if (url === "/api/v1/convert" && req.method === "POST") {
      return send(200, { request_id: "req-submitted" });
    }
    if (url.startsWith("/api/v1/convert/")) {
      const id = decodeURIComponent(url.slice("/api/v1/convert/".length));
      if (id === "boom") return send(500, { error: "down" });
      if (id === "failed-1") return send(200, { request_id: id, status: "failed" });
      if (id === "processing-1") return send(200, { request_id: id, status: "processing" });
      if (id === "complete-noimg") {
        return send(200, { request_id: id, status: "complete", markdown: "# hi", json: { a: 1 }, page_count: 2, metadata: { pages: 2 } });
      }
      if (id.startsWith("complete-img")) {
        imageRequestIds.push(id);
        return send(200, {
          request_id: id,
          status: "complete",
          markdown: "# with images",
          json: null,
          page_count: 1,
          images: { "fig1.png": IMG_B64, "fig2": `data:image/jpeg;base64,${IMG_B64}` },
          metadata: { pages: 1, ocr_stats: { chars: 10 } },
        });
      }
    }
    send(404, { error: "not found in stub" });
  });
}

function mkFile(name = "paper.pdf") {
  return new File([Buffer.from("%PDF-1.4 test")], name, { type: "application/pdf" });
}

async function call(method, qs = "", { form, headers = {} } = {}) {
  const res = await fetch(`${fnBase}/${qs}`, { method, headers, body: form });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

describe("parse-pdf-to-json", () => {
  before(async () => {
    await startServer();
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    stub = http.createServer(stubHandler);
    stub.listen(0, "127.0.0.1");
    await once(stub, "listening");
    stubBase = `http://127.0.0.1:${stub.address().port}`;

    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/", router);
    fnServer = app.listen(0, "127.0.0.1");
    await once(fnServer, "listening");
    fnBase = `http://127.0.0.1:${fnServer.address().port}`;

    process.env.DATALAB_API_KEY = KEY;
    process.env.DATALAB_API_BASE = `${stubBase}/api/v1`;
    process.env.B2_API_BASE = stubBase;
    process.env.B2_KEY_ID = "test-key-id";
    process.env.B2_APPLICATION_KEY = "test-app-key";
    process.env.B2_BUCKET_ID = "test-bucket-id";
  });

  after(async () => {
    await q("DELETE FROM public.question_images WHERE datalab_request_id = ANY($1)", [imageRequestIds]);
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await new Promise((r) => fnServer.close(r));
    await new Promise((r) => stub.close(r));
    await stopServer();
  });

  it("answers OPTIONS", async () => {
    const r = await call("OPTIONS");
    assert.equal(r.status, 200);
  });

  it("GET without request_id is a 400", async () => {
    const r = await call("GET");
    assert.equal(r.status, 400);
    assert.match(r.body.error, /POST with file\/pdf_url or GET with request_id required/);
  });

  it("POST without file or pdf_url is a 400", async () => {
    const r = await call("POST", "", { form: new FormData() });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "Either file or pdf_url is required");
  });

  it("refuses to run without DATALAB_API_KEY", async () => {
    const saved = process.env.DATALAB_API_KEY;
    delete process.env.DATALAB_API_KEY;
    try {
      const r = await call("GET", "?request_id=processing-1");
      assert.equal(r.status, 500);
      assert.equal(r.body.error, "Failed to parse PDF");
      assert.equal(r.body.details, "DATALAB_API_KEY is not configured");
    } finally {
      process.env.DATALAB_API_KEY = saved;
    }
  });

  it("submits an uploaded file and returns a request id to poll", async () => {
    const fd = new FormData();
    fd.append("file", mkFile(), "paper.pdf");
    const r = await call("POST", "", { form: fd });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "processing");
    assert.equal(r.body.request_id, "req-submitted");
    assert.ok(keysSeen.includes(KEY), "Datalab received the API key");
  });

  it("submits an http pdf_url directly", async () => {
    const fd = new FormData();
    fd.append("pdf_url", "https://example.test/paper.pdf");
    const r = await call("POST", "", { form: fd });
    assert.equal(r.status, 200);
    assert.equal(r.body.request_id, "req-submitted");
  });

  it("reports missing B2 credentials for a relative pdf path", async () => {
    const saved = process.env.B2_KEY_ID;
    delete process.env.B2_KEY_ID;
    try {
      const fd = new FormData();
      fd.append("pdf_url", "uploads/paper.pdf");
      const r = await call("POST", "", { form: fd });
      assert.equal(r.status, 500);
      assert.equal(r.body.details, "B2 credentials not configured");
    } finally {
      process.env.B2_KEY_ID = saved;
    }
  });

  it("poll: still processing is reported as-is", async () => {
    const r = await call("GET", "?request_id=processing-1");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { success: true, status: "processing", request_id: "processing-1" });
  });

  it("poll: failed job is a 500", async () => {
    const r = await call("GET", "?request_id=failed-1");
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { success: false, status: "failed", message: "Processing failed" });
  });

  it("poll: Datalab status error is a 500", async () => {
    const r = await call("GET", "?request_id=boom");
    assert.equal(r.status, 500);
    assert.equal(r.body.message, "Failed to check status");
  });

  it("poll: complete without images returns content and metadata", async () => {
    const r = await call("GET", "?request_id=complete-noimg");
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "complete");
    assert.equal(r.body.content_markdown, "# hi");
    assert.deepEqual(r.body.content_json, { a: 1 });
    assert.deepEqual(r.body.images, {});
    assert.deepEqual(r.body.metadata, { pages: 2, ocr_stats: null });
  });

  it("poll: complete with images uploads them to B2 and registers them", async () => {
    const r = await call("GET", "?request_id=complete-img-1");
    assert.equal(r.status, 200);
    assert.equal(r.body.uploaded_images.length, 2);
    assert.equal(r.body.images["fig1.png"], "question-images/extracted/complete-img-1/fig1.png");
    assert.equal(r.body.images["fig2"], "question-images/extracted/complete-img-1/fig2.jpg");
    const rows = await q(
      "SELECT original_filename, storage_path FROM public.question_images WHERE datalab_request_id = $1 ORDER BY storage_path",
      ["complete-img-1"]
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0].original_filename, "fig1.png");
    assert.equal(rows[1].original_filename, "fig2.png");
  });

  it("poll: skip_images=true does not upload", async () => {
    const r = await call("GET", "?request_id=complete-img-skip&skip_images=true");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.images, {});
    assert.deepEqual(r.body.uploaded_images, []);
  });
});
