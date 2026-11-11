// Local stand-in for the Backblaze B2 API, used by the b2-* tests. Nothing here touches the internet:
// B2_API_URL is pointed at this server while a test runs, and restored afterwards.
import http from "node:http";
import { once } from "node:events";

export const B2_TEST_ENV = {
  B2_KEY_ID: "test-key-id",
  B2_APPLICATION_KEY: "test-application-key",
  B2_BUCKET_ID: "test-bucket-id",
  B2_BUCKET_NAME: "test-bucket",
};

// Starts the fake and returns { base, calls, stop }. Each call is recorded as { method, path }.
export async function startFakeB2({ uploadPartBody } = {}) {
  const calls = [];
  const files = new Map([["files/doc.pdf", Buffer.from("%PDF-1.4 fake")]]);
  let base = "";
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, base);
    calls.push({ method: req.method, path: url.pathname });
    const json = (obj, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const p = url.pathname;
    if (p === "/b2api/v2/b2_authorize_account") {
      return json({ apiUrl: base, downloadUrl: base, authorizationToken: "auth-token" });
    }
    if (p === "/b2api/v2/b2_get_download_authorization") return json({ authorizationToken: "dl-token" });
    if (p === "/b2api/v2/b2_delete_file_version") return json({ fileId: "x" });
    if (p === "/b2api/v2/b2_list_file_names") {
      return json({
        files: [{ fileName: "files/doc.pdf", fileId: "fid-doc", size: 13 }],
        folders: ["files/"],
        nextFileName: null,
      });
    }
    if (p === "/b2api/v2/b2_get_upload_url") return json({ uploadUrl: `${base}/upload`, authorizationToken: "up-token" });
    if (p === "/upload") return json({ fileId: "fid-uploaded" });
    if (p === "/b2api/v2/b2_start_large_file") return json({ fileId: "fid-large" });
    if (p === "/b2api/v2/b2_get_upload_part_url") return json({ uploadUrl: `${base}/part`, authorizationToken: "part-token" });
    if (p === "/part") {
      if (uploadPartBody) res.writeHead(500).end(uploadPartBody);
      else res.writeHead(200).end("{}");
      return;
    }
    if (p === "/b2api/v2/b2_finish_large_file") return json({ fileId: "fid-large", fileName: "big.mp4" });
    if (p === "/b2api/v2/b2_cancel_large_file") return json({ fileId: "fid-large" });
    if (p.startsWith(`/file/${B2_TEST_ENV.B2_BUCKET_NAME}/`)) {
      const key = decodeURIComponent(p.slice(`/file/${B2_TEST_ENV.B2_BUCKET_NAME}/`.length));
      if (!files.has(key)) return json({ code: "not_found" }, 404);
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      return res.end(files.get(key));
    }
    json({ code: "unknown_path", path: p }, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    calls,
    stop: () => new Promise((r) => server.close(r)),
  };
}

// Sets the B2 env for one test run and returns a function that restores the previous values.
export function useFakeB2Env(base) {
  const saved = {};
  const next = { ...B2_TEST_ENV, B2_API_URL: base };
  for (const [k, v] of Object.entries(next)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  return () => {
    for (const k of Object.keys(next)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}
