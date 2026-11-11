// Port of supabase/functions/save-presentation-audio.
// Takes base64 WAV chunks per slide, joins them into one WAV per slide, uploads each to Backblaze B2
// with retries, and records the URLs and durations on teaching_qa_cache.
//
// Config (env): B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_ID, B2_BUCKET_NAME, and optionally
// B2_API_BASE and B2_PUBLIC_BASE (defaults are the public Backblaze hosts).
// As in the original, this route has no caller check.
import express from "express";
import { createHash } from "node:crypto";
import { query } from "../_shared/db.js";

const DEFAULT_B2_API = "https://api.backblazeb2.com";
const DEFAULT_B2_PUBLIC = "https://f005.backblazeb2.com/file";
const WAV_HEADER = 44;

export const router = express.Router();

const b2Api = () => (process.env.B2_API_BASE || DEFAULT_B2_API).replace(/\/$/, "");
const b2Public = () => (process.env.B2_PUBLIC_BASE || DEFAULT_B2_PUBLIC).replace(/\/$/, "");

// One B2 authorisation, shared by every slide in the request.
async function authorizeB2() {
  const keyId = process.env.B2_KEY_ID;
  const appKey = process.env.B2_APPLICATION_KEY;
  if (!keyId || !appKey) throw new Error("B2 credentials not configured");

  const authResponse = await fetch(`${b2Api()}/b2api/v2/b2_authorize_account`, {
    method: "GET",
    headers: { Authorization: "Basic " + Buffer.from(`${keyId}:${appKey}`).toString("base64") },
  });
  if (!authResponse.ok) {
    const errText = await authResponse.text();
    throw new Error(`B2 authorization failed: ${errText}`);
  }
  return authResponse.json();
}

async function getUploadUrl(apiUrl, authToken, bucketId) {
  const resp = await fetch(`${apiUrl}/b2api/v2/b2_get_upload_url`, {
    method: "POST",
    headers: { Authorization: authToken, "Content-Type": "application/json" },
    body: JSON.stringify({ bucketId }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Failed to get upload URL: ${errText}`);
  }
  return resp.json();
}

// Uploads one file, with a fresh upload URL per attempt (B2 recommends this after a failure).
async function uploadToB2WithRetry(fileBytes, filePath, contentType, authData, bucketId, slideIndex, maxRetries = 2) {
  const bucketName = process.env.B2_BUCKET_NAME;
  if (!bucketName) throw new Error("B2_BUCKET_NAME not configured");

  const sha1Hash = createHash("sha1").update(fileBytes).digest("hex");
  const encodedFilePath = filePath.split("/").map((s) => encodeURIComponent(s)).join("/");

  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`[SAVE-AUDIO] Slide ${slideIndex}: RETRY ${attempt}/${maxRetries} after error: ${lastError?.message}`);
      }
      const uploadUrlData = await getUploadUrl(authData.apiUrl, authData.authorizationToken, bucketId);
      const uploadResponse = await fetch(uploadUrlData.uploadUrl, {
        method: "POST",
        headers: {
          Authorization: uploadUrlData.authorizationToken,
          "X-Bz-File-Name": encodedFilePath,
          "Content-Type": contentType,
          "Content-Length": fileBytes.length.toString(),
          "X-Bz-Content-Sha1": sha1Hash,
        },
        body: fileBytes,
      });
      if (!uploadResponse.ok) {
        const errText = await uploadResponse.text();
        throw new Error(`Upload failed (${uploadResponse.status}): ${errText}`);
      }
      console.log(`[SAVE-AUDIO] Slide ${slideIndex}: uploaded on attempt ${attempt + 1}`);
      return `${b2Public()}/${bucketName}/${filePath}`;
    } catch (err) {
      lastError = err;
      console.error(`[SAVE-AUDIO] Slide ${slideIndex}: attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    }
  }
  throw lastError || new Error("All upload attempts failed");
}

// Joins WAV chunks: keeps the first header and appends each chunk's PCM data, fixing the sizes.
function concatWav(chunkBytes) {
  let dataSize = 0;
  for (const chunk of chunkBytes) dataSize += chunk.length - WAV_HEADER;
  const totalSize = WAV_HEADER + dataSize;
  const combined = new Uint8Array(totalSize);
  combined.set(chunkBytes[0].subarray(0, WAV_HEADER), 0);
  const view = new DataView(combined.buffer);
  view.setUint32(4, totalSize - 8, true);
  view.setUint32(40, dataSize, true);
  let offset = WAV_HEADER;
  for (const chunk of chunkBytes) {
    const audio = chunk.subarray(WAV_HEADER);
    combined.set(audio, offset);
    offset += audio.length;
  }
  return combined;
}

// Duration in seconds from the WAV header (sample rate, channels, bits per sample).
function wavDuration(bytes) {
  if (bytes.length <= WAV_HEADER) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sampleRate = view.getUint32(24, true);
  const numChannels = view.getUint16(22, true);
  const bitsPerSample = view.getUint16(34, true);
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  return byteRate > 0 ? (bytes.length - WAV_HEADER) / byteRate : 0;
}

router.all("/", async (req, res) => {
  if (req.method === "OPTIONS") return res.status(200).end();
  const json = (status, body) => res.status(status).json(body);
  const startTime = Date.now();

  try {
    const body = req.body ?? {};
    const cacheId = body.cache_id;
    const slides = body.slides;
    const language = body.language;

    if (!cacheId || !slides || !Array.isArray(slides) || !language) {
      return json(400, { error: "cache_id, slides array, and language are required" });
    }
    console.log(`[SAVE-AUDIO] START: ${slides.length} slides for cache_id=${cacheId}, language=${language}`);

    const bucketId = process.env.B2_BUCKET_ID;
    if (!bucketId) throw new Error("B2_BUCKET_ID not configured");

    const authData = await authorizeB2();

    const audioUrls = [];
    let totalDuration = 0;
    let failedCount = 0;

    for (const slide of slides) {
      const { slideIndex, base64Chunks } = slide;
      if (!base64Chunks || base64Chunks.length === 0) {
        console.warn(`[SAVE-AUDIO] Slide ${slideIndex}: no base64 chunks, skipping`);
        continue;
      }

      const chunkBytes = [];
      for (let c = 0; c < base64Chunks.length; c++) {
        try {
          chunkBytes.push(new Uint8Array(Buffer.from(base64Chunks[c], "base64")));
        } catch (decodeErr) {
          console.error(`[SAVE-AUDIO] Slide ${slideIndex}: chunk ${c} decode failed:`, decodeErr?.message);
        }
      }
      if (chunkBytes.length === 0) {
        console.error(`[SAVE-AUDIO] Slide ${slideIndex}: all chunks failed, skipping`);
        failedCount++;
        continue;
      }

      const combined = chunkBytes.length === 1 ? chunkBytes[0] : concatWav(chunkBytes);
      const duration = wavDuration(combined);

      const audioPath = `ai-presentations/${cacheId}/${language}/slide_${slideIndex}.wav`;
      try {
        const audioUrl = await uploadToB2WithRetry(combined, audioPath, "audio/wav", authData, bucketId, slideIndex);
        audioUrls.push({ slideIndex, audioUrl, duration });
        totalDuration += duration;
      } catch (uploadError) {
        console.error(`[SAVE-AUDIO] Slide ${slideIndex}: all retries failed:`, uploadError?.message);
        failedCount++;
      }
    }

    if (audioUrls.length > 0) {
      try {
        await query(
          "UPDATE public.teaching_qa_cache SET slide_audio_urls = $2::jsonb, total_duration_seconds = $3 WHERE id = $1",
          [cacheId, JSON.stringify({ language, urls: audioUrls }), totalDuration]
        );
        console.log(`[SAVE-AUDIO] DB updated: ${audioUrls.length} audio URLs saved`);
      } catch (updateError) {
        console.error("[SAVE-AUDIO] DB update failed:", updateError.message);
      }
    }

    const totalMs = Date.now() - startTime;
    console.log(`[SAVE-AUDIO] DONE in ${totalMs}ms: ${audioUrls.length}/${slides.length} saved, ${failedCount} failed`);
    return json(200, { success: true, audioUrls, totalDuration, processingTimeMs: totalMs, failedCount });
  } catch (error) {
    console.error("[SAVE-AUDIO] FATAL ERROR:", error?.message);
    return json(500, { error: error instanceof Error ? error.message : "Unknown error" });
  }
});

export default router;
