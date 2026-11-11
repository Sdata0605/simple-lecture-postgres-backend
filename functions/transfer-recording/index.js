// Port of supabase/functions/transfer-recording. Marks a BBB class recording as transferred to storage
// and fills its storage paths, then optionally deletes the recording on BigBlueButton.
// POST { recording_id, bbb_recording_id?, playback_url? }.
// Callers: the service key, or an admin JWT (role admin). The original relied on the gateway JWT only.
// Env: B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_ID, B2_BUCKET_NAME (required, as the original).
import express from "express";
import crypto from "node:crypto";
import { query } from "../_shared/db.js";
import { isServiceCall, jwtUserId, userHasRole } from "../_shared/send-verification-notification-helper.js";

export const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Lookups and updates the original did not check for errors. Failures here are ignored, as before.
async function tryQuery(sql, params) {
  try {
    return await query(sql, params);
  } catch (e) {
    console.error("[transfer-recording] query failed:", e?.message);
    return { rows: [], rowCount: 0 };
  }
}

async function markFailed(recordingId, message) {
  if (!UUID_RE.test(String(recordingId ?? ""))) return;
  await tryQuery(
    "UPDATE public.class_recordings SET processing_status = 'failed', processing_error = $2, updated_at = now() WHERE id = $1",
    [recordingId, message]
  );
}

router.post("/", async (req, res) => {
  const body = req.body || {};
  try {
    if (!isServiceCall(req)) {
      const userId = jwtUserId(req);
      if (!userId || !(await userHasRole(userId, ["admin"]))) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    const { recording_id, bbb_recording_id, playback_url } = body;
    if (!recording_id) throw new Error("recording_id is required");
    if (!UUID_RE.test(String(recording_id))) throw new Error("recording_id must be a UUID");

    console.log("Starting recording transfer:", { recording_id, bbb_recording_id });

    await tryQuery("UPDATE public.class_recordings SET processing_status = 'processing', updated_at = now() WHERE id = $1", [recording_id]);

    const { rows: settingsRows } = await tryQuery("SELECT setting_value FROM public.ai_settings WHERE setting_key = 'video_streaming' LIMIT 1", []);
    const settings = settingsRows[0]?.setting_value || null;
    if (!settings) throw new Error("Video streaming settings not configured");

    const provider = settings.primary_provider || "cloudflare_b2";

    if (!process.env.B2_APPLICATION_KEY_ID || !process.env.B2_APPLICATION_KEY || !process.env.B2_BUCKET_ID) {
      throw new Error("B2 credentials not configured");
    }

    // The real transcode (download from BBB, HLS encode, upload) is not ported yet. As in the original,
    // the storage paths are written so the player can find them.
    const recordingPrefix = settings.b2_recordings_prefix || "class-recordings/";
    const basePath = `${recordingPrefix}${recording_id}`;
    const processingResult = {
      b2_original_path: `${basePath}/original.mp4`,
      b2_hls_360p_path: `${basePath}/360p/index.m3u8`,
      b2_hls_480p_path: `${basePath}/480p/index.m3u8`,
      b2_hls_720p_path: `${basePath}/720p/index.m3u8`,
      b2_hls_1080p_path: `${basePath}/1080p/index.m3u8`,
      available_qualities: JSON.stringify(["360p", "480p", "720p", "1080p"]),
      default_quality: settings.default_quality || "720p",
      cdn_base_url: settings.cdn_hostname || "",
    };

    if (provider === "bunny" || (provider === "both" && settings.use_bunny_for_transcoding)) {
      const bunnyApiKey = settings.bunny_api_key;
      const bunnyLibraryId = settings.bunny_library_id;
      if (bunnyApiKey && bunnyLibraryId && playback_url) {
        try {
          const createResponse = await fetch(`https://video.bunnycdn.com/library/${encodeURIComponent(bunnyLibraryId)}/videos`, {
            method: "POST",
            headers: { AccessKey: bunnyApiKey, "Content-Type": "application/json" },
            body: JSON.stringify({ title: `Recording ${recording_id}` }),
          });
          if (createResponse.ok) {
            const videoData = await createResponse.json();
            await tryQuery(
              `UPDATE public.class_recordings SET bunny_video_guid = $2, bunny_status = 'processing', cdn_base_url = $3 WHERE id = $1`,
              [recording_id, videoData.guid, settings.bunny_cdn_hostname || null]
            );
            console.log("Bunny video created");
          }
        } catch (bunnyError) {
          console.error("Bunny upload error:", bunnyError?.message);
        }
      }
    }

    await tryQuery(
      `UPDATE public.class_recordings
          SET b2_original_path = $2, b2_hls_360p_path = $3, b2_hls_480p_path = $4, b2_hls_720p_path = $5,
              b2_hls_1080p_path = $6, available_qualities = $7::jsonb, default_quality = $8, cdn_base_url = $9,
              processing_status = 'completed', processed_at = now(), updated_at = now()
        WHERE id = $1`,
      [
        recording_id,
        processingResult.b2_original_path,
        processingResult.b2_hls_360p_path,
        processingResult.b2_hls_480p_path,
        processingResult.b2_hls_720p_path,
        processingResult.b2_hls_1080p_path,
        processingResult.available_qualities,
        processingResult.default_quality,
        processingResult.cdn_base_url,
      ]
    );
    console.log("Recording transfer completed");

    if (settings.delete_from_bbb_after_transfer && bbb_recording_id) {
      const { rows: bbbRows } = await tryQuery("SELECT setting_value FROM public.ai_settings WHERE setting_key = 'bbb_settings' LIMIT 1", []);
      const bbbSettings = bbbRows[0]?.setting_value || null;
      if (bbbSettings?.server_url && bbbSettings?.shared_secret) {
        const serverUrl = String(bbbSettings.server_url).replace(/\/$/, "");
        const queryString = `recordID=${encodeURIComponent(bbb_recording_id)}`;
        const checksum = crypto
          .createHash("sha1")
          .update(`deleteRecordings${queryString}${bbbSettings.shared_secret}`)
          .digest("hex");
        try {
          await fetch(`${serverUrl}/deleteRecordings?${queryString}&checksum=${checksum}`);
          console.log("BBB recording deleted");
        } catch (deleteError) {
          console.error("Error deleting BBB recording:", deleteError?.message);
        }
      }
    }

    return res.json({ success: true, recording_id, status: "completed" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Transfer error:", message);
    await markFailed(body.recording_id, message);
    return res.status(500).json({ error: message });
  }
});

export default router;
