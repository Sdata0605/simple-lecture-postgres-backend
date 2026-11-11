// Port of supabase/functions/sarvam-tts.
// Text to speech through Sarvam (bulbul:v2). Long text is split into chunks of up to 400 characters
// and each chunk is synthesised in turn. Returns base64 audio (one string, or an array when chunked).
//
// The Sarvam key comes from SARVAM_API_KEY. SARVAM_API_URL may override the endpoint (tests use this).
// As in the original, this route has no caller check.
import express from "express";

const DEFAULT_SARVAM_URL = "https://api.sarvam.ai/text-to-speech";
const CHUNK_MAX = 400;

export const router = express.Router();

// Speaker by gender. The original mapped every language to the same two voices.
function speakerFor(gender) {
  return gender === "female" ? "meera" : "abhilash";
}

const LANGUAGES = ["en-IN", "hi-IN", "kn-IN", "ta-IN", "te-IN", "ml-IN", "mr-IN", "bn-IN", "gu-IN", "pa-IN", "od-IN"];
const mapLanguageCode = (code) => (LANGUAGES.includes(code) ? code : "en-IN");

// Splits text at sentence, comma or space boundaries, never longer than maxLength.
export function splitTextIntoChunks(text, maxLength = CHUNK_MAX) {
  const chunks = [];
  let remaining = String(text).trim();

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let breakPoint = -1;
    const searchRange = remaining.substring(0, maxLength);

    const sentenceEnd = Math.max(
      searchRange.lastIndexOf(". "),
      searchRange.lastIndexOf("! "),
      searchRange.lastIndexOf("? ")
    );
    if (sentenceEnd > maxLength * 0.5) breakPoint = sentenceEnd + 1;

    if (breakPoint === -1) {
      const commaPoint = searchRange.lastIndexOf(", ");
      if (commaPoint > maxLength * 0.5) breakPoint = commaPoint + 1;
    }

    if (breakPoint === -1) {
      const spacePoint = searchRange.lastIndexOf(" ");
      breakPoint = spacePoint > 0 ? spacePoint : maxLength;
    }

    chunks.push(remaining.substring(0, breakPoint).trim());
    remaining = remaining.substring(breakPoint).trim();
  }

  return chunks.filter((c) => c.length > 0);
}

// One chunk, with up to three attempts. 429 responses are retried with a 1 s, then 2 s backoff.
async function makeTTSRequest(chunk, sarvamLangCode, speaker, apiKey, maxRetries = 3) {
  const url = process.env.SARVAM_API_URL || DEFAULT_SARVAM_URL;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 4000);
      console.log(`  Retry ${attempt}/${maxRetries}, waiting ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "API-Subscription-Key": apiKey },
        body: JSON.stringify({
          inputs: [chunk],
          target_language_code: sarvamLangCode,
          speaker,
          speech_sample_rate: 22050,
          model: "bulbul:v2",
          pace: 0.85,
        }),
      });

      if (response.status === 429) {
        console.log(`  Rate limited on attempt ${attempt + 1}, will retry...`);
        continue;
      }
      if (!response.ok) {
        const errorText = await response.text();
        console.error("Sarvam API error:", response.status);
        return { success: false, error: errorText };
      }

      const result = await response.json();
      if (result.audios && result.audios.length > 0) {
        return { success: true, audio: result.audios[0] };
      }
      return { success: false, error: "No audio in response" };
    } catch (err) {
      console.error(`Request error on attempt ${attempt + 1}:`, err?.message);
      if (attempt === maxRetries - 1) {
        return { success: false, error: err instanceof Error ? err.message : "Request failed" };
      }
    }
  }

  return { success: false, error: "Max retries exceeded due to rate limiting" };
}

router.all("/", async (req, res) => {
  if (req.method === "OPTIONS") return res.status(200).end();
  const json = (status, body) => res.status(status).json(body);

  try {
    const body = req.body ?? {};
    const text = body.text;
    const languageCode = body.languageCode ?? "en-IN";
    const gender = body.gender ?? "male";

    if (!text || String(text).trim().length === 0) {
      return json(400, { error: "No text provided" });
    }

    const apiKey = process.env.SARVAM_API_KEY;
    if (!apiKey) {
      console.error("SARVAM_API_KEY not configured");
      return json(500, { error: "SARVAM_API_KEY not configured" });
    }

    const speaker = speakerFor(gender);
    const sarvamLangCode = mapLanguageCode(languageCode);
    const chunks = splitTextIntoChunks(text);
    console.log(`Sarvam TTS: ${chunks.length} chunks, lang=${sarvamLangCode}, speaker=${speaker}`);

    const audioChunks = [];
    for (let i = 0; i < chunks.length; i++) {
      const result = await makeTTSRequest(chunks[i], sarvamLangCode, speaker, apiKey);
      if (!result.success) {
        return json(503, { error: "Sarvam TTS failed", details: result.error, fallback: true });
      }
      audioChunks.push(result.audio);
    }

    console.log(`Sarvam TTS success: ${audioChunks.length} audio chunks`);
    return json(200, {
      audioContent: audioChunks.length === 1 ? audioChunks[0] : audioChunks,
      isChunked: audioChunks.length > 1,
      chunkCount: audioChunks.length,
      languageCode: sarvamLangCode,
      voice: speaker,
    });
  } catch (error) {
    console.error("Sarvam TTS error:", error?.message);
    return json(500, { error: error instanceof Error ? error.message : "Unknown error", fallback: true });
  }
});

export default router;
