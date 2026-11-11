// Call-reminder audio: one shared TTS + cache path for every caller. Ported from reminderAudio.ts.
// Files are stored per owner: reminder-audio/<user_id>/<hash>.<ext>. Nothing is shared between users.
//   gemini: Gemini TTS -> WAV, hash v2 (keys: _shared/geminiKeys.js).
//   sarvam: Sarvam Bulbul v3 -> MP3, hash v1. Primary when REMINDER_TTS_ENGINE=sarvam,
//           or automatic fallback when Gemini fails (or has no keys).
// Never log or return API keys, tokens, or reminder text.
import { query } from "./db.js";
import { list, upload, createSignedUrl } from "./storage.js";
import { loadGeminiKeys } from "./geminiKeys.js";
import { STYLE_VERSION, base64ToBytes, resolveGeminiVoice, styleFor, synthesize } from "./geminiTts.js";
import { sha256Hex } from "./hash.js";

export const BUCKET = "reminder-audio";
export const MAX_TEXT_LEN = 500;
export const DEFAULT_TTL_SEC = 3600;
export const MAX_TTL_SEC = 86400;
export const DEFAULT_VOICE = "shubh";
export const DEFAULT_LANGUAGE = "en-IN";

// Bulbul v3 speakers (lowercase, as the API expects).
export const SARVAM_VOICES = [
  "shubh", "aditya", "ritu", "priya", "neha", "rahul", "pooja", "rohan", "simran",
  "kavya", "amit", "dev", "ishita", "shreya", "ratan", "varun", "manan", "sumit",
  "roopa", "kabir", "aayan", "ashutosh", "advait", "anand", "tanya", "tarun", "sunny",
  "mani", "gokul", "vijay", "shruti", "suhani", "mohit", "kavitha", "rehan", "soham",
  "rupali",
];

// Launch languages only (English, Hindi, Marathi, Kannada).
export const ALLOWED_LANGUAGES = ["en-IN", "hi-IN", "mr-IN", "kn-IN"];

const GEMINI_TIMEOUT_MS = 10000;
const GEMINI_ATTEMPTS = 2;
const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash-tts";
const SARVAM_MODEL = "bulbul:v3";
const SARVAM_PACE = 0.9;
const SARVAM_SAMPLE_RATE = 24000;
const SARVAM_URL = "https://api.sarvam.ai/text-to-speech";
const SARVAM_TIMEOUT_MS = 12000; // Sarvam as the primary engine (2 attempts)
const SARVAM_FALLBACK_TIMEOUT_MS = 8000; // Sarvam after a Gemini failure (1 attempt)
const RETRY_DELAY_MS = 1500;

export const sarvamSpeakerFor = (voice) => (SARVAM_VOICES.includes(voice) ? voice : DEFAULT_VOICE);

async function logUsage(userId, chars, cached, success, model) {
  try {
    await query(
      "INSERT INTO public.reminder_tts_usage (user_id, chars, cached, model, success) VALUES ($1, $2, $3, $4, $5)",
      [userId, chars, cached, model, success]
    );
  } catch (e) {
    console.error("usage log failed", e.message);
  }
}

async function markReminder(reminderId, userId, fields) {
  try {
    const cols = Object.keys(fields);
    const sets = cols.map((c, i) => `"${c}" = $${i + 1}`).join(", ");
    await query(
      `UPDATE public.reminders SET ${sets} WHERE id = $${cols.length + 1} AND user_id = $${cols.length + 2}`,
      [...Object.values(fields), reminderId, userId]
    );
  } catch (e) {
    console.error("reminder update failed", e.message);
  }
}

// Calls Sarvam once. Returns the response, or null on network/timeout error.
async function callSarvamOnce(apiKey, body, timeoutMs) {
  try {
    return await fetch(SARVAM_URL, {
      method: "POST",
      headers: { "api-subscription-key": apiKey, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }
}

const fail = (status, error, extra = {}) => ({ ok: false, status, error, extra });

/**
 * Returns audio for one call reminder text, for one user.
 * Cache first (same hash as always), then TTS (Gemini, Sarvam fallback), then upload and a signed URL.
 * If reminderId is given, the caller has already checked that the reminder belongs to userId.
 * Never throws for expected failures: returns { ok: false, status, error, extra }.
 */
export async function generateForUser(userId, text, voice, language, reminderId = null, ttlSec = DEFAULT_TTL_SEC) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed.length < 1 || trimmed.length > MAX_TEXT_LEN) return fail(400, "invalid_input", { field: "text" });
  const ttl = Math.min(Math.max(1, Math.floor(ttlSec)), MAX_TTL_SEC);

  // ── Engine, hashes and cache lookup ───────────────────────────────────
  const normalised = trimmed.replace(/\s+/g, " ");
  const engineSetting = process.env.REMINDER_TTS_ENGINE === "sarvam" ? "sarvam" : "gemini";
  const geminiModel = (process.env.REMINDER_TTS_MODEL ?? "").trim() || DEFAULT_GEMINI_MODEL;
  const geminiVoice = resolveGeminiVoice(voice);
  const sarvamSpeaker = sarvamSpeakerFor(voice);

  const geminiHash = sha256Hex(`v2|gemini|${geminiModel}|${geminiVoice}|${language}|${STYLE_VERSION}|${normalised}`);
  const sarvamHash = sha256Hex(`v1|${SARVAM_MODEL}|${sarvamSpeaker}|${language}|${SARVAM_PACE}|${normalised}`);

  // The primary engine decides which cached file is valid to return.
  const primary = engineSetting === "gemini"
    ? { engine: "gemini", hash: geminiHash, ext: "wav", model: geminiModel }
    : { engine: "sarvam", hash: sarvamHash, ext: "mp3", model: SARVAM_MODEL };
  const fileName = `${primary.hash}.${primary.ext}`;
  const hashPrefix = primary.hash.slice(0, 12);

  const existing = await list(BUCKET, userId, { search: fileName, limit: 5 });
  const isCached = existing.some((f) => f.name === fileName);

  if (isCached) {
    const audioPath = `${userId}/${fileName}`;
    const signedUrl = createSignedUrl(BUCKET, audioPath, ttl);
    if (reminderId) {
      await markReminder(reminderId, userId, { audio_path: audioPath, audio_hash: primary.hash, audio_status: "ready" });
    }
    await logUsage(userId, 0, true, true, primary.model);
    console.log(JSON.stringify({ fn: "reminder-audio", user: userId, hash: hashPrefix, engine: primary.engine, chars: 0, cached: true }));
    return {
      ok: true, audioPath, hash: primary.hash, signedUrl, cached: true,
      voice, language, model: primary.model, engine: primary.engine, format: primary.ext,
    };
  }

  // ── Kill switch and keys ──────────────────────────────────────────────
  if (process.env.CALL_REMINDERS_ENABLED === "false") return fail(503, "disabled");
  const sarvamKey = process.env.SARVAM_API_KEY ?? "";
  const geminiKeys = engineSetting === "gemini" ? await loadGeminiKeys() : [];
  if (geminiKeys.length === 0 && !sarvamKey) return fail(503, "not_configured");

  // ── Generate: Gemini first, Sarvam as automatic fallback ──────────────
  const started = Date.now();
  let generated = null;
  let geminiStatus;
  let sarvamStatus;
  let sarvamCode;

  if (geminiKeys.length > 0) {
    const g = await synthesize({
      keys: geminiKeys,
      model: geminiModel,
      voice: geminiVoice,
      text: normalised,
      timeoutMs: GEMINI_TIMEOUT_MS,
      attempts: GEMINI_ATTEMPTS,
    });
    geminiStatus = g.status;
    if (g.ok) {
      generated = { engine: "gemini", model: geminiModel, format: "wav", mime: "audio/wav", hash: geminiHash, bytes: g.wav };
    } else {
      console.log(JSON.stringify({ fn: "reminder-audio", user: userId, hash: hashPrefix, engine: "gemini", geminiStatus, attempts: g.attempts, ok: false }));
    }
  }

  if (!generated && sarvamKey) {
    const sarvamPrimary = engineSetting === "sarvam";
    const sarvamAttempts = sarvamPrimary ? 2 : 1;
    const sarvamTimeout = sarvamPrimary ? SARVAM_TIMEOUT_MS : SARVAM_FALLBACK_TIMEOUT_MS;
    const sarvamBody = JSON.stringify({
      text: normalised,
      language_code: language,
      speaker: sarvamSpeaker,
      model: SARVAM_MODEL,
      pace: SARVAM_PACE,
      speech_sample_rate: SARVAM_SAMPLE_RATE,
      output_audio_codec: "mp3",
    });

    let sarvamRes = null;
    for (let attempt = 1; attempt <= sarvamAttempts; attempt++) {
      sarvamRes = await callSarvamOnce(sarvamKey, sarvamBody, sarvamTimeout);
      const retryable = sarvamRes === null || sarvamRes.status === 429 || sarvamRes.status >= 500;
      if (!retryable || attempt === sarvamAttempts) break;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
    sarvamStatus = sarvamRes?.status ?? 0;

    let sarvamPayload = null;
    if (sarvamRes) sarvamPayload = await sarvamRes.json().catch(() => null);
    const base64Audio = sarvamRes && sarvamRes.ok && Array.isArray(sarvamPayload?.audios) ? sarvamPayload.audios[0] : undefined;
    if (typeof base64Audio === "string" && base64Audio.length > 0) {
      const bytes = base64ToBytes(base64Audio);
      if (bytes.length > 0) {
        generated = { engine: "sarvam", model: SARVAM_MODEL, format: "mp3", mime: "audio/mpeg", hash: sarvamHash, bytes };
      }
    }
    if (!generated) {
      sarvamCode = typeof sarvamPayload?.error?.code === "string" ? sarvamPayload.error.code : undefined;
    }
  }

  const latencyMs = Date.now() - started;

  if (!generated) {
    console.log(JSON.stringify({
      fn: "reminder-audio", user: userId, hash: hashPrefix, chars: normalised.length,
      engine: primary.engine, cached: false, geminiStatus, sarvamStatus, latencyMs, ok: false,
    }));
    await logUsage(userId, normalised.length, false, false, primary.model);
    if (reminderId) await markReminder(reminderId, userId, { audio_status: "failed" });
    return fail(502, "tts_failed", {
      ...(geminiStatus !== undefined ? { geminiStatus } : {}),
      ...(sarvamStatus !== undefined ? { sarvamStatus } : {}),
      ...(sarvamCode ? { sarvamCode } : {}),
    });
  }

  // ── Upload ────────────────────────────────────────────────────────────
  const audioPath = `${userId}/${generated.hash}.${generated.format}`;
  try {
    await upload(BUCKET, audioPath, Buffer.from(generated.bytes));
  } catch (e) {
    console.error("upload failed", e.message);
    await logUsage(userId, normalised.length, false, false, generated.model);
    if (reminderId) await markReminder(reminderId, userId, { audio_status: "failed" });
    return fail(500, "storage_failed");
  }

  // ── Usage, reminder row, signed URL ───────────────────────────────────
  await logUsage(userId, normalised.length, false, true, generated.model);
  console.log(JSON.stringify({
    fn: "reminder-audio", user: userId, hash: generated.hash.slice(0, 12), chars: normalised.length,
    engine: generated.engine, cached: false, geminiStatus, sarvamStatus, latencyMs, ok: true,
  }));
  if (reminderId) {
    await markReminder(reminderId, userId, { audio_path: audioPath, audio_hash: generated.hash, audio_status: "ready" });
  }

  return {
    ok: true, audioPath, hash: generated.hash, signedUrl: createSignedUrl(BUCKET, audioPath, ttl), cached: false,
    voice, language, model: generated.model, engine: generated.engine, format: generated.format,
  };
}
