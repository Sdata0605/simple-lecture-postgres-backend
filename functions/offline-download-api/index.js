// Port of supabase/functions/offline-download-api.
// One endpoint, dispatched on body.action: request | list | complete | revoke.
// Every error is returned as HTTP 500 with { error: message }, as in the original.
import express from "express";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { query } from "../_shared/db.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_B2_DOWNLOAD_BASE = "https://f005.backblazeb2.com/file";

export const router = express.Router();

const toNumber = (v) => (v === null || v === undefined ? v : Number(v));

function userFromAuthHeader(authHeader) {
  if (!authHeader) throw new Error("Authorization required");
  let payload;
  try {
    payload = jwt.verify(authHeader.replace("Bearer ", ""), process.env.JWT_SECRET);
  } catch {
    throw new Error("Invalid token");
  }
  if (!payload.sub) throw new Error("Invalid token");
  return { id: payload.sub };
}

async function handleRequest(user, { recording_id, quality, device_id }) {
  const { rows: settingRows } = await query(
    "SELECT setting_value FROM public.ai_settings WHERE setting_key = 'video_streaming' LIMIT 1"
  );
  const videoSettings = settingRows[0]?.setting_value || {};
  const maxDownloads = videoSettings.max_downloads_per_user || 10;
  const expiryDays = videoSettings.offline_download_expiry_days || 30;

  const { rows: countRows } = await query(
    "SELECT count(*)::int AS n FROM public.offline_downloads WHERE user_id = $1 AND is_revoked = false",
    [user.id]
  );
  if ((countRows[0]?.n || 0) >= maxDownloads) {
    throw new Error(`Maximum ${maxDownloads} offline downloads reached`);
  }

  const recording = UUID_RE.test(String(recording_id ?? ""))
    ? (await query("SELECT * FROM public.class_recordings WHERE id = $1", [recording_id])).rows[0]
    : undefined;
  if (!recording) throw new Error("Recording not found");

  const encryptionKey = randomUUID() + randomUUID();
  const iv = randomUUID().replace(/-/g, "").substring(0, 32);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + Number(expiryDays));

  // Same as the upsert in the original: a repeat request for the same recording, user and device
  // replaces the earlier row. A missing quality keeps the stored one (or the 720p default).
  const { rows: downloadRows } = await query(
    `INSERT INTO public.offline_downloads
       (recording_id, user_id, device_id, quality, encryption_key_encrypted, encryption_iv,
        file_size_bytes, download_status, expires_at)
     VALUES ($1, $2, $3, COALESCE($4, '720p'), $5, $6, $7, 'ready', $8)
     ON CONFLICT (recording_id, user_id, device_id) DO UPDATE SET
       quality = COALESCE($4, public.offline_downloads.quality),
       encryption_key_encrypted = EXCLUDED.encryption_key_encrypted,
       encryption_iv = EXCLUDED.encryption_iv,
       file_size_bytes = EXCLUDED.file_size_bytes,
       download_status = EXCLUDED.download_status,
       expires_at = EXCLUDED.expires_at
     RETURNING *`,
    [
      recording_id,
      user.id,
      device_id ?? null,
      quality ?? null,
      encryptionKey,
      iv,
      recording.file_size_bytes,
      expiresAt.toISOString(),
    ]
  );
  const download = downloadRows[0];

  // Backblaze B2 host comes from env; the bucket name comes from the settings row, as before.
  const b2Base = (process.env.B2_DOWNLOAD_BASE_URL || DEFAULT_B2_DOWNLOAD_BASE).replace(/\/$/, "");
  const downloadUrl = recording.b2_encrypted_path
    ? `${b2Base}/${videoSettings.b2_recordings_bucket || "recordings"}/${recording.b2_encrypted_path}`
    : null;

  return {
    downloadId: download.id,
    downloadUrl,
    encryptedKey: encryptionKey,
    iv,
    fileSize: toNumber(recording.file_size_bytes),
    expiresAt: expiresAt.getTime(),
  };
}

async function handleList(user) {
  const { rows } = await query(
    `SELECT d.*,
       CASE WHEN r.id IS NULL THEN NULL ELSE json_build_object(
         'id', r.id,
         'original_filename', r.original_filename,
         'duration_seconds', r.duration_seconds,
         'scheduled_class', CASE WHEN sc.id IS NULL THEN NULL ELSE json_build_object(
           'subject', sc.subject,
           'course', CASE WHEN c.id IS NULL THEN NULL ELSE json_build_object('name', c.name) END
         ) END
       ) END AS recording
     FROM public.offline_downloads d
     LEFT JOIN public.class_recordings r ON r.id = d.recording_id
     LEFT JOIN public.scheduled_classes sc ON sc.id = r.scheduled_class_id
     LEFT JOIN public.courses c ON c.id = sc.course_id
     WHERE d.user_id = $1 AND d.is_revoked = false
     ORDER BY d.created_at DESC`,
    [user.id]
  );
  // bigint comes back as a string from pg; PostgREST sent it as a number.
  for (const row of rows) row.file_size_bytes = toNumber(row.file_size_bytes);
  return { downloads: rows };
}

// Ownership is enforced by the user_id condition, as in the original. A malformed id matches nothing.
async function handleComplete(user, { download_id }) {
  if (UUID_RE.test(String(download_id ?? ""))) {
    await query(
      `UPDATE public.offline_downloads SET download_status = 'completed', downloaded_at = now()
        WHERE id = $1 AND user_id = $2`,
      [download_id, user.id]
    );
  }
  return { success: true };
}

async function handleRevoke(user, { download_id, reason }) {
  if (UUID_RE.test(String(download_id ?? ""))) {
    await query(
      `UPDATE public.offline_downloads
          SET is_revoked = true, revoked_at = now(), revoked_reason = $3
        WHERE id = $1 AND user_id = $2`,
      [download_id, user.id, reason || "User requested"]
    );
  }
  return { success: true };
}

router.all("/", async (req, res) => {
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const user = userFromAuthHeader(req.headers.authorization);
    const { action, ...params } = req.body || {};
    console.log("Offline download API:", action);

    switch (action) {
      case "request":
        return res.status(200).json(await handleRequest(user, params));
      case "list":
        return res.status(200).json(await handleList(user));
      case "complete":
        return res.status(200).json(await handleComplete(user, params));
      case "revoke":
        return res.status(200).json(await handleRevoke(user, params));
      default:
        return res.status(400).json({ error: "Unknown action" });
    }
  } catch (error) {
    console.error("Offline download API error:", error?.message);
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

export default router;
