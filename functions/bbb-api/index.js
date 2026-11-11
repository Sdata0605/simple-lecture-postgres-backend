// Port of supabase/functions/bbb-api. Creates, joins, ends, and inspects BigBlueButton meetings for scheduled
// classes. The BBB server URL and shared secret come from ai_settings ('bigbluebutton'), or from the request for
// test-connection. Errors return 400 { error }, as before.
// Auth (added in this port; the original had none of its own): any signed-in user (Bearer JWT) may use
// join, info, and recordings. create, end, and test-connection need an admin (or SERVICE_KEY as Bearer).
import crypto from "node:crypto";
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";

export const router = express.Router();

const sha1Hex = (s) => crypto.createHash("sha1").update(s, "utf8").digest("hex");

// BBB checksum: sha1(apiCall + queryString + sharedSecret).
function buildBBBUrl(serverUrl, apiCall, params, secret) {
  const queryString = new URLSearchParams(params).toString();
  const checksum = sha1Hex(apiCall + queryString + secret);
  return `${serverUrl}/${apiCall}?${queryString}&checksum=${checksum}`;
}

function parseXMLValue(xml, tag) {
  const match = String(xml).match(new RegExp(`<${tag}>([^<]*)</${tag}>`, "i"));
  return match ? match[1] : null;
}

const parseXMLBoolean = (xml, tag) => String(parseXMLValue(xml, tag)).toLowerCase() === "true";

async function getBBBSettings(overrideUrl, overrideSecret) {
  if (overrideUrl && overrideSecret) return { server_url: overrideUrl, shared_secret: overrideSecret };

  const { rows } = await query("SELECT setting_value FROM public.ai_settings WHERE setting_key = 'bigbluebutton' LIMIT 1");
  const settings = rows[0]?.setting_value;
  if (!settings) throw new Error("BigBlueButton is not configured. Please configure it in Admin Settings.");
  if (!settings.enabled || !settings.server_url || !settings.shared_secret) {
    throw new Error("BigBlueButton is not enabled or missing configuration.");
  }
  return {
    ...settings,
    server_url: String(settings.server_url).replace(/\/$/, ""),
    shared_secret: settings.shared_secret,
  };
}

// Returns { userId, isAdmin } for a valid Bearer token, or null.
async function callerFrom(req) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  if (process.env.SERVICE_KEY && token === process.env.SERVICE_KEY) return { userId: null, isAdmin: true };
  let userId = null;
  try {
    userId = jwt.verify(token, process.env.JWT_SECRET)?.sub || null;
  } catch {
    return null;
  }
  if (!userId) return null;
  const { rows } = await query("SELECT has_role($1::uuid, 'admin'::app_role) AS ok", [userId]);
  return { userId, isAdmin: !!rows[0]?.ok };
}

async function classBbbFields(scheduledClassId, columns) {
  const { rows } = await query(`SELECT ${columns} FROM public.scheduled_classes WHERE id = $1`, [scheduledClassId]);
  return rows[0] || null;
}

router.post("/", async (req, res) => {
  const fail = (message) => res.status(400).json({ error: message });
  try {
    const caller = await callerFrom(req);
    if (!caller) return res.status(401).json({ error: "Unauthorized" });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const { action, scheduled_class_id, server_url, shared_secret, ...params } = body;
    const adminOnly = action === "create" || action === "end" || action === "test-connection";
    if (adminOnly && !caller.isAdmin) return res.status(403).json({ error: "Admins only" });

    if (action === "test-connection") {
      if (!server_url || !shared_secret) return fail("Server URL and shared secret are required for testing connection");
      const testUrl = buildBBBUrl(String(server_url).replace(/\/$/, ""), "getMeetings", {}, shared_secret);
      const xml = await (await fetch(testUrl)).text();
      if (parseXMLValue(xml, "returncode") !== "SUCCESS") {
        return fail("Failed to connect to BigBlueButton server. Please check your credentials.");
      }
      return res.json({ success: true });
    }

    const settings = await getBBBSettings(server_url, shared_secret);
    const baseUrl = settings.server_url;
    const secret = settings.shared_secret;

    switch (action) {
      case "create": {
        const { rows } = await query(
          `SELECT sc.*, ps.name AS subject_name
             FROM public.scheduled_classes sc
             LEFT JOIN public.popular_subjects ps ON ps.id = sc.subject_id
            WHERE sc.id = $1`,
          [scheduled_class_id]
        );
        const classData = rows[0];
        if (!classData) return fail("Scheduled class not found");

        const meetingId = `class-${scheduled_class_id}`;
        const attendeePW = crypto.randomUUID().slice(0, 8);
        const moderatorPW = crypto.randomUUID().slice(0, 8);
        const meetingName = params.meeting_name || classData.subject_name || "Class Session";

        const createParams = {
          meetingID: meetingId,
          name: meetingName,
          attendeePW,
          moderatorPW,
          welcome: params.welcome_message || settings.default_welcome_message || "Welcome to the class!",
          record: String(params.record ?? settings.allow_recording ?? true),
          autoStartRecording: String(params.auto_start_recording ?? settings.auto_start_recording ?? false),
          muteOnStart: String(settings.mute_on_start ?? true),
          allowModsToUnmuteUsers: String(settings.allow_mods_to_unmute_users ?? true),
        };
        if (settings.default_logout_url) createParams.logoutURL = settings.default_logout_url;

        const xml = await (await fetch(buildBBBUrl(baseUrl, "create", createParams, secret))).text();
        if (parseXMLValue(xml, "returncode") !== "SUCCESS") {
          return fail(parseXMLValue(xml, "message") || "Failed to create meeting");
        }
        const internalMeetingId = parseXMLValue(xml, "internalMeetingID");

        await query(
          `UPDATE public.scheduled_classes
              SET bbb_meeting_id = $2, bbb_internal_meeting_id = $3, bbb_attendee_pw = $4, bbb_moderator_pw = $5,
                  is_live = true, live_started_at = $6
            WHERE id = $1`,
          [scheduled_class_id, meetingId, internalMeetingId, attendeePW, moderatorPW, new Date().toISOString()]
        );
        return res.json({ success: true, meetingId, internalMeetingId });
      }

      case "join": {
        const classData = await classBbbFields(scheduled_class_id, "bbb_meeting_id, bbb_attendee_pw, bbb_moderator_pw");
        if (!classData?.bbb_meeting_id) {
          return fail("Meeting not found. Please ask the instructor to start the meeting.");
        }
        const password = params.role === "moderator" ? classData.bbb_moderator_pw : classData.bbb_attendee_pw;
        const joinUrl = buildBBBUrl(
          baseUrl,
          "join",
          { meetingID: classData.bbb_meeting_id, fullName: params.full_name || "Guest", password, redirect: "true" },
          secret
        );
        return res.json({ joinUrl });
      }

      case "end": {
        const classData = await classBbbFields(scheduled_class_id, "bbb_meeting_id, bbb_moderator_pw");
        if (!classData?.bbb_meeting_id) return fail("Meeting not found");
        const endUrl = buildBBBUrl(baseUrl, "end", { meetingID: classData.bbb_meeting_id, password: classData.bbb_moderator_pw }, secret);
        await (await fetch(endUrl)).text();
        await query("UPDATE public.scheduled_classes SET is_live = false, live_ended_at = $2 WHERE id = $1", [
          scheduled_class_id,
          new Date().toISOString(),
        ]);
        return res.json({ success: true });
      }

      case "info": {
        const classData = await classBbbFields(scheduled_class_id, "bbb_meeting_id");
        if (!classData?.bbb_meeting_id) return res.json({ running: false });
        const xml = await (await fetch(buildBBBUrl(baseUrl, "getMeetingInfo", { meetingID: classData.bbb_meeting_id }, secret))).text();
        const participantCount = parseInt(parseXMLValue(xml, "participantCount") || "0", 10);
        const moderatorCount = parseInt(parseXMLValue(xml, "moderatorCount") || "0", 10);
        return res.json({
          running: parseXMLBoolean(xml, "running"),
          participantCount,
          moderatorCount,
          attendeeCount: participantCount - moderatorCount,
          startTime: parseXMLValue(xml, "startTime"),
          recording: parseXMLBoolean(xml, "recording"),
        });
      }

      case "recordings": {
        const classData = await classBbbFields(scheduled_class_id, "bbb_meeting_id");
        if (!classData?.bbb_meeting_id) return res.json({ recordings: [] });
        const xml = await (await fetch(buildBBBUrl(baseUrl, "getRecordings", { meetingID: classData.bbb_meeting_id }, secret))).text();
        const recordings = [];
        for (const recordingXml of xml.match(/<recording>([\s\S]*?)<\/recording>/g) || []) {
          recordings.push({
            recordID: parseXMLValue(recordingXml, "recordID"),
            meetingID: parseXMLValue(recordingXml, "meetingID"),
            name: parseXMLValue(recordingXml, "name"),
            startTime: parseXMLValue(recordingXml, "startTime"),
            endTime: parseXMLValue(recordingXml, "endTime"),
            playbackUrl: recordingXml.match(/<url>([^<]*)<\/url>/)?.[1] || null,
          });
        }
        return res.json({ recordings });
      }

      default:
        return fail(`Unknown action: ${action}`);
    }
  } catch (error) {
    console.error("BBB API error:", error?.message);
    return fail(error instanceof Error ? error.message : "Unknown error");
  }
});
