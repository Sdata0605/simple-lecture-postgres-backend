// File storage that replaces Supabase Storage. Files live on this server's disk, under
// UPLOAD_DIR/<bucket>/<path>. Signed URLs are HMAC-signed with JWT_SECRET and expire.
// Paths are checked so a request can never leave its bucket folder.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(process.cwd(), "storage-data"));

// Turns a bucket or object path into a safe relative path inside UPLOAD_DIR, or throws.
function safeRel(...parts) {
  const rel = path.posix.normalize(parts.join("/")).replace(/^\/+/, "");
  if (!rel || rel.startsWith("..") || rel.includes("/../") || rel.includes("\0")) {
    throw new Error("invalid storage path");
  }
  return rel;
}
function absFor(bucket, objectPath) {
  // Reject '..' and empty segments before normalising, so nothing can climb out of its bucket.
  const segments = String(objectPath).split("/");
  if (segments.some((s) => s === ".." || s === "" && segments.length > 1 && segments.indexOf(s) !== segments.length - 1)) {
    throw new Error("invalid storage path");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(bucket)) throw new Error("invalid bucket");
  const full = path.resolve(UPLOAD_DIR, safeRel(bucket, objectPath));
  if (!full.startsWith(UPLOAD_DIR + path.sep)) throw new Error("invalid storage path");
  return full;
}

export async function upload(bucket, objectPath, bytes) {
  const file = absFor(bucket, objectPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
  return { path: objectPath };
}

// Lists file names in bucket/prefix whose name contains `search`.
export async function list(bucket, prefix, { search = "", limit = 100 } = {}) {
  const dir = absFor(bucket, prefix);
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.includes(search)).slice(0, limit).map((name) => ({ name }));
}

const sign = (bucket, objectPath, expires) =>
  crypto.createHmac("sha256", process.env.JWT_SECRET).update(`${bucket}/${objectPath}|${expires}`).digest("hex");

// Returns a URL that serves the file until `ttlSec` seconds from now.
export function createSignedUrl(bucket, objectPath, ttlSec) {
  absFor(bucket, objectPath); // reject bad paths up front
  const expires = Math.floor(Date.now() / 1000) + ttlSec;
  const base = (process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${process.env.PORT || 8787}`).replace(/\/$/, "");
  const token = sign(bucket, objectPath, expires);
  return `${base}/storage/v1/object/sign/${bucket}/${objectPath}?token=${token}&expires=${expires}`;
}

export function verifySignedToken(bucket, objectPath, token, expires) {
  const exp = Number(expires);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = sign(bucket, objectPath, exp);
  return typeof token === "string" && token.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

export async function readFile(bucket, objectPath) {
  return fs.readFile(absFor(bucket, objectPath));
}

// True when a file already exists at bucket/objectPath. Throws "invalid storage path" for bad paths.
export async function exists(bucket, objectPath) {
  const file = absFor(bucket, objectPath);
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

// Root folder on disk, used by tests to clean up.
export const UPLOAD_ROOT = UPLOAD_DIR;
