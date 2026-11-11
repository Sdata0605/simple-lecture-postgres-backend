// Port of supabase/functions/streaming-api. Video playback helper for class recordings.
// POST { action, ...params } with Authorization: Bearer <user JWT>. Actions:
//   get-playback-url { recording_id, quality? }  -> HLS and direct URLs (CDN, or a Backblaze B2 link)
//   list-recordings  { course_id?, limit? }      -> ready recordings with their scheduled class
//   report-quality   { recording_id, user_id, metrics } -> logs network quality, recommends a quality
//   test-cloudflare  {}                          -> placeholder success
// Errors keep the original shape: 500 { error } for thrown errors, 400 for an unknown action.
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";

export const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B2_AUTH_URL = "https://api.backblazeb2.com/b2api/v2/b2_authorize_account";

// Authorises with B2 and returns a download URL for filePath, or null on any failure.
async function getB2DownloadAuth(filePath, bucketName) {
  try {
    const keyId = process.env.B2_KEY_ID;
    const appKey = process.env.B2_APPLICATION_KEY;
    if (!keyId || !appKey) {
      console.error("B2 credentials not configured");
      return null;
    }

    const authResponse = await fetch(B2_AUTH_URL, {
      headers: { Authorization: "Basic " + Buffer.from(`${keyId}:${appKey}`).toString("base64") },
    });
    if (!authResponse.ok) {
      console.error("B2 auth failed: HTTP", authResponse.status);
      return null;
    }
    const authData = await authResponse.json();
    const downloadUrl = `${authData.downloadUrl}/file/${bucketName}/${filePath}`;

    const downloadAuthResponse = await fetch(`${authData.apiUrl}/b2api/v2/b2_get_download_authorization`, {
      method: "POST",
      headers: { Authorization: authData.authorizationToken, "Content-Type": "application/json" },
      body: JSON.stringify({
        bucketId: process.env.B2_BUCKET_ID,
        fileNamePrefix: filePath,
        validDurationInSeconds: 3600,
      }),
    });
    if (!downloadAuthResponse.ok) {
      console.error("B2 download auth failed: HTTP", downloadAuthResponse.status);
      return downloadUrl; // unsigned fallback, as the original
    }
    const downloadAuth = await downloadAuthResponse.json();
    return `${downloadUrl}?Authorization=${downloadAuth.authorizationToken}`;
  } catch (err) {
    console.error("B2 auth error:", err?.message);
    return null;
  }
}

function signedInUser(req) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  try {
    return jwt.verify(token, process.env.JWT_SECRET).sub || null;
  } catch {
    return null;
  }
}

async function getVideoSettings() {
  const { rows } = await query("SELECT setting_value FROM public.ai_settings WHERE setting_key = 'video_streaming' LIMIT 1");
  return rows[0]?.setting_value || {};
}

async function getPlaybackUrl(params) {
  const { recording_id, quality = "720p" } = params;
  if (!UUID_RE.test(String(recording_id ?? ""))) throw new Error("Recording not found");
  const { rows } = await query("SELECT * FROM public.class_recordings WHERE id = $1", [recording_id]);
  const recording = rows[0];
  if (!recording) throw new Error("Recording not found");

  const videoSettings = await getVideoSettings();
  const cdnHostname = videoSettings.cdn_hostname || "";
  const bucketName = process.env.B2_BUCKET_NAME || videoSettings.b2_recordings_bucket || "class-recordings";

  const qualityPaths = {
    "360p": recording.b2_hls_360p_path,
    "480p": recording.b2_hls_480p_path,
    "720p": recording.b2_hls_720p_path,
    "1080p": recording.b2_hls_1080p_path,
  };
  const selectedPath = qualityPaths[quality] || recording.b2_hls_720p_path;
  const hasHls = selectedPath || recording.bunny_video_guid;

  let hlsUrl = null;
  if (cdnHostname && selectedPath) {
    hlsUrl = `https://${cdnHostname}/${selectedPath}`;
  } else if (recording.bunny_video_guid && videoSettings.bunny_cdn_hostname) {
    hlsUrl = `https://${videoSettings.bunny_cdn_hostname}/${recording.bunny_video_guid}/playlist.m3u8`;
  }

  let directUrl = null;
  if (recording.b2_original_path) {
    if (cdnHostname) {
      directUrl = `https://${cdnHostname}/file/${bucketName}/${recording.b2_original_path}`;
    } else {
      directUrl = await getB2DownloadAuth(recording.b2_original_path, bucketName);
    }
  }

  return {
    hlsUrl,
    directUrl,
    quality: hasHls ? quality : "original",
    availableQualities: hasHls ? (recording.available_qualities || ["360p", "480p", "720p", "1080p"]) : ["original"],
    duration: recording.duration_seconds,
    expiresAt: Date.now() + 3600000,
    usingCdn: !!cdnHostname,
  };
}

async function listRecordings(params) {
  const { course_id, limit = 50 } = params;
  if (course_id !== undefined && course_id !== null && !UUID_RE.test(String(course_id))) {
    throw new Error("invalid course_id");
  }
  // Mirrors the PostgREST embed: recordings are always returned, and scheduled_class is filled only
  // when it belongs to the requested course.
  const { rows } = await query(
    `SELECT cr.id, cr.duration_seconds, cr.available_qualities, cr.default_quality, cr.processing_status, cr.created_at,
            CASE WHEN sc.id IS NULL THEN NULL ELSE json_build_object(
              'id', sc.id, 'subject', sc.subject, 'scheduled_at', sc.scheduled_at,
              'course', CASE WHEN c.id IS NULL THEN NULL ELSE json_build_object('id', c.id, 'name', c.name) END
            ) END AS scheduled_class
       FROM public.class_recordings cr
       LEFT JOIN public.scheduled_classes sc
              ON sc.id = cr.scheduled_class_id AND ($1::uuid IS NULL OR sc.course_id = $1::uuid)
       LEFT JOIN public.courses c ON c.id = sc.course_id
      WHERE cr.processing_status = 'ready'
      ORDER BY cr.created_at DESC
      LIMIT $2`,
    [course_id ?? null, Number(limit)]
  );
  return { recordings: rows };
}

async function reportQuality(params) {
  const { recording_id, user_id, metrics } = params;
  if (!metrics || typeof metrics !== "object") throw new Error("metrics is required");
  // The original ignored insert errors here, so a bad id does not fail the request.
  await query(
    `INSERT INTO public.network_quality_logs
       (recording_id, user_id, connection_type, effective_bandwidth_mbps, latency_ms, initial_quality, adapted_to_quality, buffer_events)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      UUID_RE.test(String(recording_id ?? "")) ? recording_id : null,
      UUID_RE.test(String(user_id ?? "")) ? user_id : null,
      metrics.connectionType ?? null,
      metrics.bandwidth ?? null,
      metrics.latency ?? null,
      metrics.initialQuality ?? null,
      metrics.currentQuality ?? null,
      metrics.bufferEvents || 0,
    ]
  ).catch((e) => console.error("network_quality_logs insert failed:", e?.message));

  let recommendedQuality;
  if (metrics.bandwidth >= 5) recommendedQuality = "1080p";
  else if (metrics.bandwidth >= 2.5) recommendedQuality = "720p";
  else if (metrics.bandwidth >= 1) recommendedQuality = "480p";
  else recommendedQuality = "360p";
  return { recommendedQuality };
}

router.post("/", async (req, res) => {
  try {
    if (!signedInUser(req)) return res.status(401).json({ error: "Unauthorized" });

    const { action, ...params } = req.body || {};
    console.log("Streaming API action:", action);

    switch (action) {
      case "get-playback-url":
        return res.json(await getPlaybackUrl(params));
      case "list-recordings":
        return res.json(await listRecordings(params));
      case "report-quality":
        return res.json(await reportQuality(params));
      case "test-cloudflare":
        return res.json({ success: true });
      default:
        return res.status(400).json({ error: "Unknown action" });
    }
  } catch (error) {
    console.error("Streaming API error:", error?.message);
    return res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

export default router;
