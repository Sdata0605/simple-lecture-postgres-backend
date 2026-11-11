import crypto from "node:crypto";

// Same 6-digit generator and SHA-256 hashing as the Supabase edge functions.
export function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function sha256(message) {
  return crypto.createHash("sha256").update(message).digest("hex");
}

export const minutesFromNow = (m) => new Date(Date.now() + m * 60 * 1000);
