// Port of supabase/functions/indic-parler-tts. Sends text to the Indic Parler TTS server in chunks
// of up to 500 characters, downloads each WAV and joins them into one WAV response.
// Env: INDIC_PARLER_API_KEY (required), INDIC_PARLER_BASE_URL (the TTS server, e.g. http://host:8000).
// Auth: Bearer user token (the original relied on the platform JWT gate).
import express from "express";
import jwt from "jsonwebtoken";

export const router = express.Router();

// Test hook: lets tests stub the TTS server so no real request is sent.
export const hooks = {
  fetch: (...args) => fetch(...args),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const WAV_HEADER_BYTES = 44;

function hasValidBearer(req) {
  const h = req.get("Authorization") || "";
  if (!h.startsWith("Bearer ")) return false;
  try {
    return Boolean(jwt.verify(h.slice(7), process.env.JWT_SECRET)?.sub);
  } catch {
    return false;
  }
}

// Text chunking for long content. Splits at a sentence, comma or space when one is near enough.
export function splitTextIntoChunks(text, maxLength = 500) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remainingText = text;
  while (remainingText.length > 0) {
    if (remainingText.length <= maxLength) {
      chunks.push(remainingText);
      break;
    }
    let splitIndex = remainingText.lastIndexOf(". ", maxLength);
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) splitIndex = remainingText.lastIndexOf(", ", maxLength);
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) splitIndex = remainingText.lastIndexOf(" ", maxLength);
    if (splitIndex === -1 || splitIndex < maxLength * 0.3) splitIndex = maxLength;

    chunks.push(remainingText.substring(0, splitIndex + 1).trim());
    remainingText = remainingText.substring(splitIndex + 1).trim();
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

// One chunk through the TTS server. Returns { success, audioBuffer } or { success: false, error }.
async function makeTTSRequest(text, description, apiKey, ttsBase, maxRetries = 2) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const retry = async () => {
      if (attempt < maxRetries - 1) {
        await hooks.sleep(1000 * (attempt + 1));
        return true;
      }
      return false;
    };
    try {
      const response = await hooks.fetch(`${ttsBase}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({ text, description }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!response.ok) {
        console.error(`TTS API error (${response.status})`);
        if (response.status === 401 || response.status === 403) return { success: false, error: "Invalid API key" };
        if (await retry()) continue;
        return { success: false, error: `TTS API error: ${response.status}` };
      }

      const result = await response.json();
      if (result.status !== "success" || !result.audio_url) {
        console.error("TTS response missing audio_url");
        return { success: false, error: "Invalid TTS response" };
      }

      const audioResponse = await hooks.fetch(`${ttsBase}${result.audio_url}`, {
        signal: AbortSignal.timeout(120_000),
      });
      if (!audioResponse.ok) {
        console.error(`Failed to download audio: ${audioResponse.status}`);
        return { success: false, error: "Failed to download audio" };
      }
      const audioBuffer = await audioResponse.arrayBuffer();
      return { success: true, audioBuffer };
    } catch (error) {
      console.error(`TTS request error (attempt ${attempt + 1}):`, error?.message);
      if (await retry()) continue;
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  }
  return { success: false, error: "Max retries exceeded" };
}

// Joins WAV files that share one format. The 44-byte header of each file is dropped after the first.
export function concatenateWavBuffers(buffers) {
  if (buffers.length === 0) return new ArrayBuffer(0);
  if (buffers.length === 1) return buffers[0];

  let totalDataSize = 0;
  for (const buffer of buffers) totalDataSize += buffer.byteLength - WAV_HEADER_BYTES;

  const firstView = new DataView(buffers[0]);
  const numChannels = firstView.getUint16(22, true);
  const sampleRate = firstView.getUint32(24, true);
  const bitsPerSample = firstView.getUint16(34, true);
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);

  const resultBuffer = new ArrayBuffer(WAV_HEADER_BYTES + totalDataSize);
  const resultView = new DataView(resultBuffer);
  const resultBytes = new Uint8Array(resultBuffer);

  resultBytes.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  resultView.setUint32(4, 36 + totalDataSize, true);
  resultBytes.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
  resultBytes.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
  resultView.setUint32(16, 16, true);
  resultView.setUint16(20, 1, true); // PCM
  resultView.setUint16(22, numChannels, true);
  resultView.setUint32(24, sampleRate, true);
  resultView.setUint32(28, byteRate, true);
  resultView.setUint16(32, blockAlign, true);
  resultView.setUint16(34, bitsPerSample, true);
  resultBytes.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
  resultView.setUint32(40, totalDataSize, true);

  let offset = WAV_HEADER_BYTES;
  for (const buffer of buffers) {
    const sourceBytes = new Uint8Array(buffer, WAV_HEADER_BYTES);
    resultBytes.set(sourceBytes, offset);
    offset += sourceBytes.length;
  }
  return resultBuffer;
}

router.post("/", async (req, res) => {
  try {
    if (!hasValidBearer(req)) return res.status(401).json({ error: "Unauthorized" });
    const { text, description, languageCode } = req.body || {};

    if (!text || String(text).trim().length === 0) {
      return res.status(400).json({ error: "Text is required" });
    }

    const apiKey = process.env.INDIC_PARLER_API_KEY;
    const ttsBase = (process.env.INDIC_PARLER_BASE_URL || "").replace(/\/$/, "");
    if (!apiKey || !ttsBase) {
      console.error("INDIC_PARLER_API_KEY or INDIC_PARLER_BASE_URL not configured");
      return res.status(500).json({ error: "TTS service not configured" });
    }

    const voiceDescription =
      description ||
      (languageCode === "hi-IN"
        ? "Divya speaks clearly with very clear audio and moderate speed"
        : "Female voice with clear pronunciation and normal pace");

    const cleanText = String(text).trim();
    const chunks = splitTextIntoChunks(cleanText, 500);

    const audioBuffers = [];
    for (let i = 0; i < chunks.length; i++) {
      const result = await makeTTSRequest(chunks[i], voiceDescription, apiKey, ttsBase);
      if (!result.success || !result.audioBuffer) {
        return res.status(500).json({ error: `Failed at chunk ${i + 1}: ${result.error}` });
      }
      audioBuffers.push(result.audioBuffer);
    }

    const finalAudio = Buffer.from(concatenateWavBuffers(audioBuffers));
    res.set("Content-Type", "audio/wav");
    res.set("Content-Length", String(finalAudio.byteLength));
    res.send(finalAudio);
  } catch (error) {
    console.error("Edge function error:", error?.message);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});
