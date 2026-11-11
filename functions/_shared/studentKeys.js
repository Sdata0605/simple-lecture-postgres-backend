// Per-student Gemini API keys for the AI Teacher (bring-your-own-key), ported from
// supabase/functions/_shared/studentKeys.ts. Keys are stored as plain text, as in the original
// (key_ciphertext holds the plain key; iv is kept empty). Never log or return a full key.
import crypto from "node:crypto";
import { query } from "./db.js";

const RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;

export async function encryptKey(plain) {
  return { cipher: plain, iv: "" };
}
export async function decryptKey(cipher) {
  return cipher;
}

// Display form only: 'AIza…' + the last 4 characters.
export const maskKey = (last4) => `AIza…${last4}`;

export function sha256Hex(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

// A key is usable unless invalid, or rate-limited within the last 60 minutes.
export function isUsableKey(status, lastErrorAt, now = Date.now()) {
  if (status === "invalid") return false;
  if (status === "rate_limited") return !!lastErrorAt && now - Date.parse(lastErrorAt) >= RATE_LIMIT_COOLDOWN_MS;
  return true;
}

// Stores a key's status. Failures (rate_limited, invalid) also stamp last_error_at.
export async function markKey(id, status, err) {
  const failed = status === "rate_limited" || status === "invalid";
  // Never store anything that looks like a key.
  const message = err ? err.replace(/AIza[\w-]{6,}/g, "AIza…").slice(0, 300) : null;
  await query(
    `UPDATE public.ai_teacher_user_keys
        SET status = $2, last_error = $3, last_error_at = $4, updated_at = now()
      WHERE id = $1`,
    [id, status, message, failed ? new Date() : null]
  );
}

// Records that a key was used successfully.
export async function touchKey(id) {
  await query("UPDATE public.ai_teacher_user_keys SET last_used_at = now() WHERE id = $1", [id]);
}

// Sets (or clears) the user's active key. Creates the prefs row if it does not exist yet.
export async function setActiveKey(userId, keyId) {
  await query(
    `INSERT INTO public.ai_teacher_user_prefs (user_id, active_key_id, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET active_key_id = EXCLUDED.active_key_id, updated_at = now()`,
    [userId, keyId]
  );
}

// Classifies a failed Gemini call. 'rate_limited' for 429 or RESOURCE_EXHAUSTED; 'invalid' for
// 401, 403 (PERMISSION_DENIED), or 400 with API_KEY_INVALID; null for anything else.
export function classifyGeminiError(httpStatus, bodyText) {
  const text = String(bodyText ?? "");
  if (httpStatus === 429 || text.includes("RESOURCE_EXHAUSTED")) return "rate_limited";
  if (httpStatus === 401 || httpStatus === 403 || text.includes("PERMISSION_DENIED")) return "invalid";
  if (httpStatus === 400 && text.includes("API_KEY_INVALID")) return "invalid";
  return null;
}

// Loads a student's usable keys with plain text: the active key first, then by position.
// Skips 'invalid' keys and keys rate-limited in the last 60 minutes.
export async function loadStudentKeys(userId) {
  const [keys, pref] = await Promise.all([
    query(
      `SELECT id, label, key_ciphertext, key_iv, key_last4, position, status, last_error, last_error_at, last_used_at
         FROM public.ai_teacher_user_keys WHERE user_id = $1 ORDER BY position ASC`,
      [userId]
    ),
    query("SELECT active_key_id FROM public.ai_teacher_user_prefs WHERE user_id = $1", [userId]),
  ]);
  const activeId = pref.rows[0]?.active_key_id ?? null;
  const now = Date.now();
  const rows = keys.rows.filter((r) => isUsableKey(r.status, r.last_error_at, now));
  rows.sort((a, b) => (a.id === activeId ? 0 : 1) - (b.id === activeId ? 0 : 1) || a.position - b.position);
  const out = [];
  for (const r of rows) {
    out.push({
      id: r.id,
      label: r.label ?? "",
      key: await decryptKey(r.key_ciphertext, r.key_iv),
      last4: r.key_last4,
      position: r.position,
      status: r.status,
      lastError: r.last_error ?? null,
      lastErrorAt: r.last_error_at ?? null,
      lastUsedAt: r.last_used_at ?? null,
    });
  }
  return out;
}
