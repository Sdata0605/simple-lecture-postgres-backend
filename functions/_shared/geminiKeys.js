// Gemini API keys for server-side reminder voice generation. Ported from geminiKeys.ts.
// Order: optional env REMINDER_GEMINI_API_KEY first, then the AI Teacher config row in
// public.ai_settings ('ai_teacher_1to1_config'): google_api_key, then key_pool[].key where
// status !== 'invalid'. Trimmed, de-duplicated, cached for 60 seconds.
// Keys are never logged or returned.
import { query } from "./db.js";

const CACHE_MS = 60_000;
const CONFIG_ROW = "ai_teacher_1to1_config";
let cache = null;

// Tests set hooks.keys to a fixed list so no real key (or real network call) is ever used.
export const hooks = { keys: null };

export function clearGeminiKeyCache() {
  cache = null;
}

export async function loadGeminiKeys() {
  if (hooks.keys) return hooks.keys;
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.keys;

  const keys = [];
  const override = (process.env.REMINDER_GEMINI_API_KEY ?? "").trim();
  if (override) keys.push(override);

  let loadedOk = true;
  try {
    const { rows } = await query("SELECT setting_value FROM public.ai_settings WHERE setting_key = $1 LIMIT 1", [CONFIG_ROW]);
    const v = rows[0]?.setting_value ?? {};
    if (typeof v.google_api_key === "string" && v.google_api_key.trim()) keys.push(v.google_api_key.trim());
    if (Array.isArray(v.key_pool)) {
      for (const item of v.key_pool) {
        const isObj = typeof item === "object" && item !== null;
        const k = typeof item === "string" ? item : isObj ? item.key : undefined;
        const status = isObj ? item.status : undefined;
        if (typeof k === "string" && k.trim() && status !== "invalid") keys.push(k.trim());
      }
    }
  } catch {
    loadedOk = false;
    console.error("gemini key config load failed");
  }

  const unique = [...new Set(keys)];
  if (loadedOk) cache = { keys: unique, at: Date.now() };
  return unique;
}
