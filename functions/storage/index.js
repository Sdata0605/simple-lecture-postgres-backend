// Storage routes (mounted at /storage/v1):
//   GET  /object/sign/<bucket>/<path>?token&expires  signed link (private or public buckets)
//   POST /object/<bucket>/<path>                      upload, needs a signed-in user
//   GET  /object/public/<bucket>/<path>               public read, public buckets only
import express from "express";
import jwt from "jsonwebtoken";
import { exists, readFile, upload, verifySignedToken } from "../_shared/storage.js";
import {
  bucketPolicy,
  contentTypeFor,
  extensionForMime,
  extensionOf,
} from "../_shared/storage-buckets.js";

export const router = express.Router();

const TYPES = { wav: "audio/wav", mp3: "audio/mpeg", png: "image/png", jpg: "image/jpeg", pdf: "application/pdf" };
// Allowance on top of maxBytes for multipart framing (boundaries and form fields).
const MULTIPART_OVERHEAD = 1024 * 1024;

const sendError = (res, status, error, message) =>
  res.status(status).json({ statusCode: String(status), error, message });

// The signed-in user's id from `Authorization: Bearer <jwt>`, or null.
function userIdFromBearer(req) {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Bearer ")) return null;
  try {
    const payload = jwt.verify(header.slice(7).trim(), process.env.JWT_SECRET);
    return payload?.sub || null;
  } catch {
    return null;
  }
}

// Reads the request body as raw bytes, up to `limit`. Resolves with undefined when there is no body.
function readRawBody(req, res, limit) {
  return new Promise((resolve, reject) => {
    express.raw({ type: () => true, limit })(req, res, (err) => (err ? reject(err) : resolve(req.body)));
  });
}

const isInvalidPath = (e) => /^invalid (storage path|bucket)$/.test(e.message);

router.get(/^\/object\/sign\/([^/]+)\/(.+)$/, async (req, res) => {
  const bucket = req.params[0];
  const objectPath = req.params[1];
  if (!verifySignedToken(bucket, objectPath, req.query.token, req.query.expires)) {
    return res.status(403).json({ error: "invalid_or_expired_link" });
  }
  try {
    const bytes = await readFile(bucket, objectPath);
    const ext = objectPath.split(".").pop().toLowerCase();
    res.setHeader("Content-Type", TYPES[ext] || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=300");
    return res.send(bytes);
  } catch {
    return res.status(404).json({ error: "not_found" });
  }
});

// Upload. Accepts multipart/form-data (the file in a field with an empty name, as supabase-js sends it)
// or raw bytes with the file's Content-Type. x-upsert: "true" replaces an existing file.
router.post(/^\/object\/([^/]+)\/(.+)$/, async (req, res) => {
  const bucket = req.params[0];
  const objectPath = req.params[1];
  try {
    if (!userIdFromBearer(req)) {
      return sendError(res, 401, "Unauthorized", "Missing or invalid token");
    }
    const policy = bucketPolicy(bucket);
    if (!policy) return sendError(res, 400, "BucketNotFound", "Bucket not found");

    const declared = Number(req.headers["content-length"] || 0);
    if (declared > policy.maxBytes + MULTIPART_OVERHEAD) {
      return sendError(res, 413, "EntityTooLarge", "The object exceeded the maximum allowed size");
    }

    const contentType = String(req.headers["content-type"] || "");
    const mainType = contentType.split(";")[0].trim().toLowerCase();
    if (mainType === "application/json") {
      // The app-level JSON parser has already read this body, so the raw bytes are gone.
      return sendError(res, 415, "UnsupportedMediaType", "Send JSON files as multipart/form-data");
    }
    let body;
    try {
      body = await readRawBody(req, res, policy.maxBytes + MULTIPART_OVERHEAD);
    } catch (e) {
      if (e.status === 413 || e.type === "entity.too.large") {
        return sendError(res, 413, "EntityTooLarge", "The object exceeded the maximum allowed size");
      }
      throw e;
    }
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return sendError(res, 400, "EmptyBody", "No file was sent");
    }

    let bytes = body;
    let fileMime = mainType;
    if (mainType === "multipart/form-data") {
      let form;
      try {
        form = await new Request("http://storage.local/upload", {
          method: "POST",
          headers: { "content-type": contentType },
          body,
        }).formData();
      } catch {
        return sendError(res, 400, "InvalidMultipart", "Could not read the multipart body");
      }
      const file = [...form.values()].find((v) => typeof v !== "string");
      if (!file) return sendError(res, 400, "NoFile", "No file found in the form");
      bytes = Buffer.from(await file.arrayBuffer());
      fileMime = String(file.type || "").toLowerCase();
    }

    if (bytes.length === 0) return sendError(res, 400, "EmptyBody", "No file was sent");
    if (bytes.length > policy.maxBytes) {
      return sendError(res, 413, "EntityTooLarge", "The object exceeded the maximum allowed size");
    }

    const ext = extensionOf(objectPath) || extensionForMime(fileMime);
    if (!ext || !policy.allowedTypes.includes(ext)) {
      return sendError(res, 415, "InvalidMimeType", `File type not allowed in ${bucket}`);
    }

    if (req.headers["x-upsert"] !== "true" && (await exists(bucket, objectPath))) {
      return sendError(res, 409, "Duplicate", "The resource already exists");
    }

    await upload(bucket, objectPath, bytes);
    return res.status(200).json({ Key: `${bucket}/${objectPath}`, path: objectPath });
  } catch (e) {
    if (isInvalidPath(e)) return sendError(res, 400, "InvalidKey", "Invalid object path");
    return sendError(res, 500, "InternalError", "Upload failed");
  }
});

// Public read: only for buckets whose policy has public: true. Anything else is 404.
router.get(/^\/object\/public\/([^/]+)\/(.+)$/, async (req, res) => {
  const bucket = req.params[0];
  const objectPath = req.params[1];
  const policy = bucketPolicy(bucket);
  if (!policy || !policy.public) {
    return sendError(res, 404, "NotFound", "Object not found");
  }
  try {
    const bytes = await readFile(bucket, objectPath);
    res.setHeader("Content-Type", contentTypeFor(extensionOf(objectPath)));
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.send(bytes);
  } catch (e) {
    if (isInvalidPath(e)) return sendError(res, 400, "InvalidKey", "Invalid object path");
    return sendError(res, 404, "NotFound", "Object not found");
  }
});
