// Port of supabase/functions/bbb-webhooks. Receives BigBlueButton meeting events (JSON or form data) and
// updates scheduled classes, attendance, and recordings. BBB cannot send a Bearer token, so this stays open
// as before. If BBB_WEBHOOK_SECRET is set, the caller must also send it in the x-webhook-secret header.
// When a recording is ready and video_streaming.auto_transfer_bbb_recordings is on, it calls the
// transfer-recording function at PUBLIC_BASE_URL with SERVICE_KEY.
import express from "express";
import { query } from "../_shared/db.js";

export const router = express.Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Accepts JSON (parsed by the app) and form data with an `event` field holding JSON.
router.post("/", express.urlencoded({ extended: false }), async (req, res) => {
  const secret = process.env.BBB_WEBHOOK_SECRET;
  if (secret && req.headers["x-webhook-secret"] !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const contentType = String(req.headers["content-type"] || "");
    let eventData;
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const event = req.body?.event;
      eventData = typeof event === "string" ? JSON.parse(event) : event;
    } else {
      eventData = req.body;
    }

    const events = Array.isArray(eventData) ? eventData : [eventData];

    for (const event of events) {
      const eventType = event?.header?.name || event?.event;
      const meetingId = event?.data?.id || event?.attributes?.meeting?.["external-meeting-id"];

      let scheduledClassId = null;
      if (meetingId) {
        const match = String(meetingId).match(/^class-(.+)$/);
        if (match) {
          scheduledClassId = match[1];
        } else {
          const { rows } = await query("SELECT id FROM public.scheduled_classes WHERE bbb_meeting_id = $1 LIMIT 1", [meetingId]);
          if (rows[0]) scheduledClassId = rows[0].id;
        }
      }
      if (!scheduledClassId) continue;

      switch (eventType) {
        case "meeting-created":
        case "MeetingCreatedEvtMsg": {
          await query("UPDATE public.scheduled_classes SET is_live = true, live_started_at = $2 WHERE id = $1", [
            scheduledClassId,
            new Date().toISOString(),
          ]);
          break;
        }

        case "meeting-ended":
        case "MeetingEndedEvtMsg": {
          await query("UPDATE public.scheduled_classes SET is_live = false, live_ended_at = $2 WHERE id = $1", [
            scheduledClassId,
            new Date().toISOString(),
          ]);
          break;
        }

        case "user-joined":
        case "UserJoinedMeetingEvtMsg": {
          const userData = event.data?.attributes?.user || event.attributes?.user || {};
          const externalUserId = userData["external-user-id"] || userData.externalUserId;
          if (externalUserId && UUID.test(externalUserId)) {
            const now = new Date().toISOString();
            try {
              await query(
                `INSERT INTO public.class_attendance (scheduled_class_id, student_id, status, joined_at, marked_at)
                 VALUES ($1, $2, 'present', $3, $3)
                 ON CONFLICT (scheduled_class_id, student_id) DO UPDATE SET
                   status = 'present', joined_at = EXCLUDED.joined_at, marked_at = EXCLUDED.marked_at`,
                [scheduledClassId, externalUserId, now]
              );
            } catch (e) {
              console.error("Error recording attendance:", e?.message);
            }
          }
          break;
        }

        case "user-left":
        case "UserLeftMeetingEvtMsg": {
          const userData = event.data?.attributes?.user || event.attributes?.user || {};
          const externalUserId = userData["external-user-id"] || userData.externalUserId;
          if (externalUserId && UUID.test(externalUserId)) {
            const { rows } = await query(
              "SELECT joined_at FROM public.class_attendance WHERE scheduled_class_id = $1 AND student_id = $2 LIMIT 1",
              [scheduledClassId, externalUserId]
            );
            if (rows[0]) {
              const leftAt = new Date();
              const durationSeconds = Math.floor((leftAt.getTime() - new Date(rows[0].joined_at).getTime()) / 1000);
              await query(
                "UPDATE public.class_attendance SET left_at = $3, duration_seconds = $4 WHERE scheduled_class_id = $1 AND student_id = $2",
                [scheduledClassId, externalUserId, leftAt.toISOString(), durationSeconds]
              );
            }
          }
          break;
        }

        case "rap-archive-ended":
        case "recording-ready": {
          const recordingData = event.data?.attributes?.recording || event.attributes?.recording || {};
          const playbackUrl = recordingData.playback?.format?.url || recordingData["playback-format"]?.url || null;
          const recordingId = recordingData.recordID || recordingData["record-id"];

          if (playbackUrl) {
            await query("UPDATE public.scheduled_classes SET recording_url = $2, recording_added_at = $3 WHERE id = $1", [
              scheduledClassId,
              playbackUrl,
              new Date().toISOString(),
            ]);

            let recording;
            try {
              const { rows } = await query(
                `INSERT INTO public.class_recordings (scheduled_class_id, bbb_recording_id, processing_status, original_filename)
                 VALUES ($1, $2, 'pending', $3) RETURNING *`,
                [scheduledClassId, recordingId, `bbb-${recordingId}.mp4`]
              );
              recording = rows[0];
            } catch (e) {
              console.error("Error creating class_recordings entry:", e?.message);
              recording = null;
            }

            if (recording) {
              const { rows: settingsRows } = await query(
                "SELECT setting_value FROM public.ai_settings WHERE setting_key = 'video_streaming' LIMIT 1"
              );
              const videoSettings = settingsRows[0]?.setting_value || null;
              const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
              if (videoSettings?.auto_transfer_bbb_recordings && base) {
                try {
                  await fetch(`${base}/functions/v1/transfer-recording`, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      Authorization: `Bearer ${process.env.SERVICE_KEY || ""}`,
                    },
                    body: JSON.stringify({
                      recording_id: recording.id,
                      bbb_recording_id: recordingId,
                      playback_url: playbackUrl,
                    }),
                  });
                } catch (transferError) {
                  console.error("Error triggering transfer:", transferError?.message);
                }
              }
            }
          }
          break;
        }

        default:
          break;
      }
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("Webhook processing error:", error?.message);
    return res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});
