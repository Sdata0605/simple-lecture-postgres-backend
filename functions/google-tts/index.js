// Port of supabase/functions/google-tts. Google Cloud Text-to-Speech (Wavenet) returns MP3 audio.
// The key comes from GOOGLE_TTS_API_KEY. Auth: the original ran behind the Supabase JWT gate,
// so this requires a valid user Bearer token.
import express from "express";
import jwt from "jsonwebtoken";

export const router = express.Router();

const getVoiceForGender = (gender) => (gender === "male" ? "Charon" : "Kore");

const getLanguageCode = (langCode) => {
  if (langCode.startsWith("hi")) return "hi-IN";
  if (langCode.startsWith("en")) return "en-US";
  return langCode;
};

function hasValidBearer(req) {
  const h = req.get("Authorization") || "";
  if (!h.startsWith("Bearer ")) return false;
  try {
    return Boolean(jwt.verify(h.slice(7), process.env.JWT_SECRET)?.sub);
  } catch {
    return false;
  }
}

router.post("/", async (req, res) => {
  try {
    if (!hasValidBearer(req)) return res.status(401).json({ error: "Unauthorized" });

    const { text, languageCode = "en-IN", gender = "female" } = req.body || {};
    if (!text || String(text).trim() === "") return res.status(400).json({ error: "Text is required" });

    const googleApiKey = process.env.GOOGLE_TTS_API_KEY;
    if (!googleApiKey) {
      console.error("GOOGLE_TTS_API_KEY not configured");
      return res.status(500).json({ error: "TTS service not configured" });
    }

    const voice = getVoiceForGender(gender);
    const lang = getLanguageCode(languageCode);

    const response = await fetch(
      "https://texttospeech.googleapis.com/v1/text:synthesize",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": googleApiKey },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: lang, name: `${lang}-Wavenet-A` },
          audioConfig: { audioEncoding: "MP3", speakingRate: 0.9, pitch: 0 },
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Google TTS API error:", response.status);
      return res.status(response.status).json({ error: "TTS synthesis failed", details: errorText });
    }

    const data = await response.json();
    res.json({ audioContent: data.audioContent, languageCode: lang, voice });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("TTS function error:", errorMessage);
    res.status(500).json({ error: errorMessage });
  }
});
