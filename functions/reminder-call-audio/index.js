// Port of supabase/functions/reminder-call-audio. Study "call reminder" audio generator.
// POST { text, voice?, language?, reminderId?, preview?, ttlSec? } -> { audioPath, hash, signedUrl, ... }
// Auth: the caller's access token. Engines and caching are in _shared/reminderAudio.js.
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";
import { GEMINI_PREBUILT_VOICES } from "../_shared/geminiTts.js";
import {
  ALLOWED_LANGUAGES,
  DEFAULT_LANGUAGE,
  DEFAULT_TTL_SEC,
  DEFAULT_VOICE,
  MAX_TEXT_LEN,
  MAX_TTL_SEC,
  SARVAM_VOICES,
  generateForUser,
} from "../_shared/reminderAudio.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (res, field, message) => res.status(400).json({ error: "invalid_input", field, message });

export const router = express.Router();

router.post("/", async (req, res) => {
  // 1. Auth
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ error: "unauthorized" });
  let userId;
  try {
    userId = jwt.verify(token, process.env.JWT_SECRET).sub;
  } catch {
    return res.status(401).json({ error: "unauthorized" });
  }

  // 2. Validate input
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid(res, "body", "Request body must be an object");

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text.length < 1 || text.length > MAX_TEXT_LEN) return invalid(res, "text", `text must be 1-${MAX_TEXT_LEN} characters`);

  const voice = body.voice === undefined ? DEFAULT_VOICE : body.voice;
  if (typeof voice !== "string" || !(SARVAM_VOICES.includes(voice) || GEMINI_PREBUILT_VOICES.includes(voice))) {
    return invalid(res, "voice", "voice is not an allowed speaker");
  }

  const language = body.language === undefined ? DEFAULT_LANGUAGE : body.language;
  if (typeof language !== "string" || !ALLOWED_LANGUAGES.includes(language)) return invalid(res, "language", "language is not supported");

  const rawReminderId = body.reminderId;
  if (rawReminderId !== undefined && rawReminderId !== null && (typeof rawReminderId !== "string" || !UUID_RE.test(rawReminderId))) {
    return invalid(res, "reminderId", "reminderId must be a uuid");
  }
  const reminderId = typeof rawReminderId === "string" ? rawReminderId : null;

  if (body.preview !== undefined && typeof body.preview !== "boolean") return invalid(res, "preview", "preview must be a boolean");
  const preview = body.preview === true;

  let ttlSec = DEFAULT_TTL_SEC;
  if (body.ttlSec !== undefined && body.ttlSec !== null) {
    if (typeof body.ttlSec !== "number" || !Number.isFinite(body.ttlSec) || body.ttlSec < 1) {
      return invalid(res, "ttlSec", "ttlSec must be a positive number of seconds");
    }
    ttlSec = Math.min(Math.floor(body.ttlSec), MAX_TTL_SEC);
  }

  // 3. Reminder ownership
  if (reminderId) {
    const { rows } = await query("SELECT id FROM public.reminders WHERE id = $1 AND user_id = $2", [reminderId, userId]);
    if (!rows[0]) return res.status(404).json({ error: "reminder_not_found" });
  }

  // 4. Generate (cache, then TTS, then upload). A preview never writes to the reminder row.
  const result = await generateForUser(userId, text, voice, language, preview ? null : reminderId, ttlSec);
  if (!result.ok) return res.status(result.status).json({ error: result.error, fallback: true, ...result.extra });

  return res.json({
    audioPath: result.audioPath,
    hash: result.hash,
    signedUrl: result.signedUrl,
    cached: result.cached,
    voice: result.voice,
    language: result.language,
    model: result.model,
    engine: result.engine,
    format: result.format,
  });
});
