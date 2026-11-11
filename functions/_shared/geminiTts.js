// Gemini text-to-speech for study call reminders (server only). Ported from geminiTts.ts.
// Output is normalised to a canonical WAV: RIFF, PCM, mono, 16-bit, 24 kHz.
// Keys are never logged or returned.

export const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
export const GEMINI_SAMPLE_RATE = 24000;
export const STYLE_VERSION = "s1";
const RETRY_DELAY_MS = 500;

// The six Sarvam names the app sends map to Gemini prebuilt voices.
export const GEMINI_VOICE_MAP = new Map([
  ["shubh", "Charon"],
  ["aditya", "Puck"],
  ["rahul", "Orus"],
  ["ritu", "Kore"],
  ["priya", "Aoede"],
  ["kavya", "Sulafat"],
]);
export const DEFAULT_GEMINI_VOICE = "Charon";

export const GEMINI_PREBUILT_VOICES = [
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe",
  "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib",
  "Rasalgethi", "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima",
  "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
];

// Maps an incoming voice (Sarvam name or Gemini prebuilt name) to a Gemini voice.
export function resolveGeminiVoice(voice) {
  const mapped = GEMINI_VOICE_MAP.get(voice);
  if (mapped) return mapped;
  if (GEMINI_PREBUILT_VOICES.includes(voice)) return voice;
  return DEFAULT_GEMINI_VOICE;
}

const LANGUAGE_NAMES = {
  "en-IN": "English with an Indian accent",
  "hi-IN": "Hindi",
  "mr-IN": "Marathi",
  "kn-IN": "Kannada",
};

export function styleFor(language) {
  const name = LANGUAGE_NAMES[language] ?? LANGUAGE_NAMES["en-IN"];
  return `Speak slowly and warmly, like a friendly Indian teacher calling a student. Language: ${name}.`;
}

export function base64ToBytes(b64) {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

// Finds the first audio part in an Interactions response.
export function extractAudio(payload) {
  const steps = Array.isArray(payload?.steps) ? payload.steps : [];
  for (const s of steps) {
    if (s?.type !== "model_output" || !Array.isArray(s.content)) continue;
    for (const c of s.content) {
      if (c?.type === "audio" && typeof c.data === "string" && c.data) {
        return { data: c.data, mime: typeof c.mime_type === "string" ? c.mime_type : "" };
      }
    }
  }
  if (typeof payload?.output_audio?.data === "string" && payload.output_audio.data) {
    return {
      data: payload.output_audio.data,
      mime: typeof payload.output_audio.mime_type === "string" ? payload.output_audio.mime_type : "",
    };
  }
  return null;
}

const ascii = (b, off, len) => String.fromCharCode(...b.subarray(off, off + len));

// Reads a 16-bit mono PCM WAV. Returns null for anything else.
export function parseWav(b) {
  if (b.length < 12 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WAVE") return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let pcm = null;
  while (off + 8 <= b.length) {
    const id = ascii(b, off, 4);
    const size = dv.getUint32(off + 4, true);
    const start = off + 8;
    if (id === "fmt " && start + 16 <= b.length) {
      channels = dv.getUint16(start + 2, true);
      sampleRate = dv.getUint32(start + 4, true);
      bits = dv.getUint16(start + 14, true);
    } else if (id === "data") {
      pcm = b.subarray(start, Math.min(b.length, start + size));
    }
    off = start + size + (size & 1);
  }
  if (!pcm || sampleRate <= 0 || bits !== 16 || channels !== 1) return null;
  return { sampleRate, pcm };
}

// Drops leading near-silence (below 200 of 32767) up to 500 ms, keeping 50 ms of lead-in.
// If the first 500 ms are all silent, the audio is returned untouched.
export function trimLeadingSilence(pcm, sampleRate) {
  const samples = pcm.length >> 1;
  const maxSkip = Math.min(samples, Math.floor(sampleRate * 0.5));
  let first = -1;
  for (let i = 0; i < maxSkip; i++) {
    const s = ((pcm[2 * i] | (pcm[2 * i + 1] << 8)) << 16) >> 16;
    if (Math.abs(s) >= 200) {
      first = i;
      break;
    }
  }
  if (first <= 0) return pcm;
  const pad = Math.floor(sampleRate * 0.05);
  const skipSamples = Math.max(0, first - pad);
  return pcm.subarray(skipSamples * 2);
}

// Writes a 44-byte RIFF header in front of 16-bit mono PCM.
export function wrapWav(pcm, sampleRate) {
  const out = new Uint8Array(44 + pcm.length);
  const dv = new DataView(out.buffer);
  const put = (off, s) => {
    for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i);
  };
  put(0, "RIFF");
  dv.setUint32(4, 36 + pcm.length, true);
  put(8, "WAVE");
  put(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true); // byte rate
  dv.setUint16(32, 2, true); // block align
  dv.setUint16(34, 16, true); // bits per sample
  put(36, "data");
  dv.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

// Turns returned audio (WAV, or raw L16 with a rate= parameter) into canonical WAV bytes.
export function toCanonicalWav(bytes, mime) {
  let sampleRate = GEMINI_SAMPLE_RATE;
  let pcm;
  const parsed = parseWav(bytes);
  if (parsed) {
    sampleRate = parsed.sampleRate;
    pcm = parsed.pcm;
  } else if (/^audio\/(l16|pcm)/i.test(mime.trim())) {
    const rate = /rate=(\d+)/i.exec(mime);
    if (rate) sampleRate = parseInt(rate[1], 10);
    pcm = bytes;
  } else {
    return null;
  }
  if (pcm.length % 2 === 1) pcm = pcm.subarray(0, pcm.length - 1);
  if (pcm.length < 2) return null;
  return wrapWav(trimLeadingSilence(pcm, sampleRate), sampleRate);
}

// Calls Gemini TTS. Rotates through keys on 401/403/429/5xx/timeout, up to `attempts` tries.
export async function synthesize({ keys, model, voice, text, timeoutMs, attempts = 2 }) {
  const started = Date.now();
  const maxAttempts = Math.max(1, attempts);
  if (keys.length === 0) return { ok: false, status: 0, latencyMs: 0, attempts: 0 };

  // speech_metadata is rejected by the live API (HTTP 400), so style is not sent.
  const body = JSON.stringify({
    model,
    input: [{ type: "text", text }],
    response_format: { type: "audio", sample_rate: GEMINI_SAMPLE_RATE },
    generation_config: { speech_config: [{ voice }] },
  });

  let status = 0;
  let made = 0;
  for (let i = 0; i < maxAttempts; i++) {
    made = i + 1;
    const key = keys[i % keys.length];
    let retryable = false;
    try {
      const res = await fetch(GEMINI_INTERACTIONS_URL, {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
      if (!res.ok) {
        retryable = res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500;
        await res.body?.cancel().catch(() => {});
      } else {
        const part = extractAudio(await res.json());
        const wav = part ? toCanonicalWav(base64ToBytes(part.data), part.mime) : null;
        if (wav) return { ok: true, wav, status, latencyMs: Date.now() - started, attempts: made };
        // 200 without usable audio: not retryable.
      }
    } catch {
      status = 0; // timeout or network error
      retryable = true;
    }
    if (!retryable || i === maxAttempts - 1) break;
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
  return { ok: false, status, latencyMs: Date.now() - started, attempts: made };
}
