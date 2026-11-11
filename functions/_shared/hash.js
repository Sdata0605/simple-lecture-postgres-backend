import crypto from "node:crypto";

// SHA-256 as lowercase hex. Used for audio cache keys, which must not change between versions.
export function sha256Hex(input) {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}
