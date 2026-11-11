// Port of supabase/functions/bharat-tts. Text-to-speech through the Bharat TTS server.
// The server address comes from BHARAT_TTS_BASE_URL (for example http://host:port, with /tts and /health).
// POST { prompt, description? }. Long text is split into chunks; the response carries base64 WAV audio.
import express from "express";

export const router = express.Router();

const HEALTH_TIMEOUT_MS = 1500;

const ttsBase = () => (process.env.BHARAT_TTS_BASE_URL || "").replace(/\/$/, "");

async function isBharatTTSServerReachable(timeoutMs = HEALTH_TIMEOUT_MS) {
  const base = ttsBase();
  if (!base) return false;
  try {
    const res = await fetch(`${base}/health`, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch (err) {
    console.warn("[BharatTTS] Health check failed:", err?.name);
    return false;
  }
}

// Splits text at sentence ends, commas, or spaces, whichever is a good break point.
function splitTextIntoChunks(text, maxLength = 500) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining.trim());
      break;
    }
    let breakPoint = maxLength;
    const sentenceEnd = remaining.lastIndexOf(". ", maxLength);
    if (sentenceEnd > maxLength * 0.5) {
      breakPoint = sentenceEnd + 1;
    } else {
      const commaEnd = remaining.lastIndexOf(", ", maxLength);
      if (commaEnd > maxLength * 0.5) {
        breakPoint = commaEnd + 1;
      } else {
        const spaceEnd = remaining.lastIndexOf(" ", maxLength);
        if (spaceEnd > maxLength * 0.3) breakPoint = spaceEnd;
      }
    }
    chunks.push(remaining.substring(0, breakPoint).trim());
    remaining = remaining.substring(breakPoint).trim();
  }
  return chunks;
}

// One chunk to the TTS server, with linear backoff between attempts.
async function makeTTSRequest(prompt, description, maxRetries = 3) {
  const url = `${ttsBase()}/tts`;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, description }),
      });
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[BharatTTS] API error: ${response.status} - ${errorText.slice(0, 200)}`);
        if (attempt === maxRetries) return { success: false, error: `API error: ${response.status}` };
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      const audio = Buffer.from(await response.arrayBuffer());
      return { success: true, audio };
    } catch (error) {
      console.error(`[BharatTTS] Request error on attempt ${attempt}:`, error?.name);
      if (attempt === maxRetries) return { success: false, error: error?.message || "Network error" };
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  return { success: false, error: "Max retries exceeded" };
}

router.post("/", async (req, res) => {
  try {
    const { prompt, description } = req.body || {};
    if (!prompt) return res.status(400).json({ ok: false, error: "prompt is required" });

    const reachable = await isBharatTTSServerReachable();
    if (!reachable) {
      console.error("[BharatTTS] Server unreachable (connection refused / firewall / down)");
      return res.json({
        ok: false,
        error: "Bharat TTS server unreachable. Ensure the Bharat TTS server is running and reachable.",
        code: "BHARAT_TTS_UNREACHABLE",
      });
    }

    const voiceDescription = description || "Warm, clear, close mic, moderate speed, professional teaching voice";
    const chunks = splitTextIntoChunks(prompt, 500);

    if (chunks.length === 1) {
      const result = await makeTTSRequest(chunks[0], voiceDescription);
      if (!result.success) return res.json({ ok: false, error: result.error || "TTS generation failed" });
      return res.json({ ok: true, audioContent: result.audio.toString("base64"), mimeType: "audio/wav", isChunked: false });
    }

    const audioContents = [];
    for (let i = 0; i < chunks.length; i++) {
      const result = await makeTTSRequest(chunks[i], voiceDescription);
      if (!result.success) {
        console.error(`[BharatTTS] Chunk ${i + 1} failed: ${result.error}`);
        continue;
      }
      audioContents.push(result.audio.toString("base64"));
    }
    if (audioContents.length === 0) return res.json({ ok: false, error: "All TTS chunks failed" });
    return res.json({ ok: true, audioContent: audioContents, mimeType: "audio/wav", isChunked: true });
  } catch (error) {
    console.error("[BharatTTS] Server error:", error?.message);
    return res.json({ ok: false, error: error instanceof Error ? error.message : "Internal server error" });
  }
});

export { splitTextIntoChunks };
