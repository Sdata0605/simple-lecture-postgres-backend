// Helpers shared by the b2-* functions (port of the Supabase Deno functions).
// Auth: Bearer JWT signed with JWT_SECRET; the user id is the token's sub.
// The B2 API base comes from B2_API_URL (defaults to Backblaze's public API) so tests can point it at a fake.
import crypto from "node:crypto";
import jwt from "jsonwebtoken";

// Throws the same messages the Supabase functions threw. Callers turn them into 500 { error }.
export function requireUserId(req) {
  const header = req.headers.authorization;
  if (!header) throw new Error("No authorization header");
  const token = String(header).replace("Bearer ", "").trim();
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload?.sub) throw new Error("no sub");
    return payload.sub;
  } catch {
    throw new Error("Unauthorized");
  }
}

export const b2ApiBase = () => (process.env.B2_API_URL || "https://api.backblazeb2.com").replace(/\/$/, "");

// Authorises with B2 using the key id and application key from env. Throws on failure.
export async function b2Authorize() {
  const keyId = process.env.B2_KEY_ID;
  const appKey = process.env.B2_APPLICATION_KEY;
  if (!keyId || !appKey) throw new Error("B2 credentials not configured");
  const res = await fetch(`${b2ApiBase()}/b2api/v2/b2_authorize_account`, {
    method: "GET",
    headers: { Authorization: "Basic " + Buffer.from(`${keyId}:${appKey}`).toString("base64") },
  });
  if (!res.ok) throw new Error(`B2 authorization failed: ${await res.text()}`);
  return res.json();
}

// Percent-encodes each segment of a path but keeps the slashes (matches how files are stored in B2).
export const encodePath = (p) => String(p).split("/").map((s) => encodeURIComponent(s)).join("/");

export const sha1Hex = (bytes) => crypto.createHash("sha1").update(bytes).digest("hex");
