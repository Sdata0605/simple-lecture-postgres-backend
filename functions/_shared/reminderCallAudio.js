// Per-user call-reminder audio for the server-side preparation path. Ported from reminderCallAudio.ts.
// Every file is stored under the owner's folder: reminder-audio/<user_id>/<hash>.<ext>.
// Hashes match reminderAudio exactly, so a file made by either path is a cache hit for the other.
import { query } from "./db.js";
import { list, upload } from "./storage.js";
import { loadGeminiKeys } from "./geminiKeys.js";
import { STYLE_VERSION, base64ToBytes, resolveGeminiVoice, styleFor, synthesize } from "./geminiTts.js";
import { sha256Hex } from "./hash.js";

const BUCKET = "reminder-audio";
const GEMINI_TIMEOUT_MS = 10000;
const GEMINI_ATTEMPTS = 2;
const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash-tts";
const SARVAM_MODEL = "bulbul:v3";
const SARVAM_PACE = 0.9;
const SARVAM_SAMPLE_RATE = 24000;
const SARVAM_URL = "https://api.sarvam.ai/text-to-speech";
const SARVAM_TIMEOUT_MS = 8000;
const SARVAM_DEFAULT_SPEAKER = "shubh";
const DEFAULT_LANGUAGE = "en-IN";
const MAX_TEXT_LEN = 500;

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

async function linkRow(reminderId, userId, audioPath, hash) {
  await query(
    "UPDATE public.reminders SET audio_path = $1, audio_hash = $2, audio_status = 'ready' WHERE id = $3 AND user_id = $4",
    [audioPath, hash, reminderId, userId]
  );
}

/**
 * Makes sure one call reminder has audio in the user's own folder, and points the row at it.
 * Returns { status, audioPath?, hash?, engine? }. Never throws.
 */
export async function ensureCallAudio({ userId, reminderId, text, voice, language }) {
  const trimmed = (text ?? "").trim();
  if (trimmed.length < 1 || trimmed.length > MAX_TEXT_LEN) return { status: "failed" };
  const normalised = trimmed.replace(/\s+/g, " ");
  const lang = language || DEFAULT_LANGUAGE;
  const spk = voice || SARVAM_DEFAULT_SPEAKER;

  const engineSetting = process.env.REMINDER_TTS_ENGINE === "sarvam" ? "sarvam" : "gemini";
  const geminiModel = (process.env.REMINDER_TTS_MODEL ?? "").trim() || DEFAULT_GEMINI_MODEL;
  const geminiVoice = resolveGeminiVoice(spk);
  const geminiHash = sha256Hex(`v2|gemini|${geminiModel}|${geminiVoice}|${lang}|${STYLE_VERSION}|${normalised}`);
  const sarvamHash = sha256Hex(`v1|${SARVAM_MODEL}|${spk}|${lang}|${SARVAM_PACE}|${normalised}`);
  const primary = engineSetting === "gemini"
    ? { engine: "gemini", hash: geminiHash, ext: "wav", model: geminiModel }
    : { engine: "sarvam", hash: sarvamHash, ext: "mp3", model: SARVAM_MODEL };

  // 1. Cache: this user's own file already exists.
  const fileName = `${primary.hash}.${primary.ext}`;
  const audioPath = `${userId}/${fileName}`;
  const existing = await list(BUCKET, userId, { search: fileName, limit: 5 });
  if (existing.some((f) => f.name === fileName)) {
    await linkRow(reminderId, userId, audioPath, primary.hash);
    await logUsage(userId, 0, true, true, primary.model);
    return { status: "cached", audioPath, hash: primary.hash, engine: primary.engine };
  }

  // 2. Keys.
  const sarvamKey = process.env.SARVAM_API_KEY ?? "";
  const geminiKeys = engineSetting === "gemini" ? await loadGeminiKeys() : [];
  if (geminiKeys.length === 0 && !sarvamKey) return { status: "not_configured" };

  // 3. Generate: Gemini first, Sarvam as fallback.
  let bytes = null;
  let format = "wav";
  let mime = "audio/wav";
  let engine = "gemini";
  let hash = geminiHash;
  let model = geminiModel;

  if (geminiKeys.length > 0) {
    const g = await synthesize({
      keys: geminiKeys,
      model: geminiModel,
      voice: geminiVoice,
      text: normalised,
      timeoutMs: GEMINI_TIMEOUT_MS,
      attempts: GEMINI_ATTEMPTS,
    });
    if (g.ok) bytes = g.wav;
  }

  if (!bytes && sarvamKey) {
    try {
      const res = await fetch(SARVAM_URL, {
        method: "POST",
        headers: { "api-subscription-key": sarvamKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          text: normalised,
          language_code: lang,
          speaker: spk,
          model: SARVAM_MODEL,
          pace: SARVAM_PACE,
          speech_sample_rate: SARVAM_SAMPLE_RATE,
          output_audio_codec: "mp3",
        }),
        signal: AbortSignal.timeout(SARVAM_TIMEOUT_MS),
      });
      const payload = res.ok ? await res.json().catch(() => null) : null;
      const b64 = Array.isArray(payload?.audios) ? payload.audios[0] : undefined;
      if (typeof b64 === "string" && b64.length > 0) {
        const decoded = base64ToBytes(b64);
        if (decoded.length > 0) {
          bytes = decoded;
          format = "mp3";
          mime = "audio/mpeg";
          engine = "sarvam";
          hash = sarvamHash;
          model = SARVAM_MODEL;
        }
      }
    } catch {
      bytes = null;
    }
  }

  if (!bytes) {
    await logUsage(userId, normalised.length, false, false, model);
    await query("UPDATE public.reminders SET audio_status = 'failed' WHERE id = $1 AND user_id = $2", [reminderId, userId]);
    return { status: "failed" };
  }

  // 4. Upload to the owner's folder only.
  const outPath = `${userId}/${hash}.${format}`;
  try {
    await upload(BUCKET, outPath, Buffer.from(bytes));
  } catch (e) {
    console.error("call audio upload failed", e.message);
    await logUsage(userId, normalised.length, false, false, model);
    return { status: "failed" };
  }

  await logUsage(userId, normalised.length, false, true, model);
  await linkRow(reminderId, userId, outPath, hash);
  console.log(JSON.stringify({ fn: "reminderCallAudio", user: userId, hash: hash.slice(0, 12), engine, ok: true }));
  return { status: "generated", audioPath: outPath, hash, engine };
}
