// Port of supabase/functions/video-generation-proxy. Every action is ported:
//   GET  ?action=media | cdn_proxy | vimeo_proxy | chatterbox_proxy   (handlers in actions/*.js)
//   POST { action: ... }   (handlers in actions/a-submit.js, b-review.js, c-chatterbox.js)
// Unknown actions return 400 (GET) or 501 "not_ported" (POST).
// Auth: POST actions need `Authorization: Bearer <user JWT>` or the service key (SERVICE_ROLE_KEY).
// Hosts: the default GPU server is VIDEO_GEN_DEFAULT_SERVER_IP; a request may pick another server_ip only
//   if it is in VIDEO_GEN_ALLOWED_SERVER_IPS (the default is always allowed). No IP is hard-coded.
import express from "express";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { Readable } from "node:stream";
import { postHandlers, getHandlers } from "./actions/index.js";
import * as H from "./helpers.js";

export const router = express.Router();

const EXTERNAL_PORT = 5006;
const MEDIA_CONTENT_TYPES = {
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};
const PORTED_POST_ACTIONS = new Set([
  "status", "avatar_status", "dub_languages", "dub_status", "list_jobs", "job_details",
]);
const PUBLIC_POST_ACTIONS = new Set(["review"]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, x-supabase-client-platform, apikey, content-type, range",
  "Access-Control-Expose-Headers": "content-length, content-range, accept-ranges",
};

const defaultServerIp = () => process.env.VIDEO_GEN_DEFAULT_SERVER_IP || "";

function allowedServerIps() {
  const set = new Set();
  if (defaultServerIp()) set.add(defaultServerIp());
  for (const ip of (process.env.VIDEO_GEN_ALLOWED_SERVER_IPS || "").split(",")) {
    const v = ip.trim();
    if (v) set.add(v);
  }
  return set;
}

// An absent server_ip means the default server, so only explicit values are checked.
const isAllowedServerIp = (ip) => !ip || allowedServerIps().has(ip);

// Rejects traversal and absolute paths in values placed into upstream URLs.
const isSafeRelativePath = (p) => !p.includes("..") && !p.startsWith("/") && !p.includes("\\");
const badRequest = (res, message) => res.status(400).json({ error: message });

function externalApiBase(serverIp) {
  const ip = serverIp || defaultServerIp();
  return `http://${ip}:${EXTERNAL_PORT}`;
}

// Returns true when the request is authorised. Otherwise it has already sent the 401.
function authorise(req, res) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authorization required" });
    return false;
  }
  const token = header.replace("Bearer ", "");
  const serviceKey = process.env.SERVICE_ROLE_KEY;
  if (serviceKey && token.length === serviceKey.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(serviceKey))) {
    return true;
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.sub) return true;
  } catch {
    // fall through to the 401 below
  }
  res.status(401).json({ error: "Invalid token" });
  return false;
}

// Streams an upstream media response through the proxy, as the original did.
async function streamUpstream(req, res, upstreamUrl, { notFoundMessage, extraHeaders, contentTypeFor }) {
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;

  let response;
  try {
    response = await fetch(upstreamUrl, { headers });
  } catch (err) {
    console.error("[proxy] upstream fetch failed:", String(err));
    return res.status(502).set(corsHeaders).json({ error: `${notFoundMessage.fetchFailed}`, detail: String(err) });
  }

  if (!response.ok && response.status !== 206) {
    return res.status(response.status).set(corsHeaders).json({ error: notFoundMessage.notFound, status: response.status });
  }

  res.status(response.status);
  res.set({
    ...corsHeaders,
    "Content-Type": contentTypeFor(response),
    "Cache-Control": "public, max-age=86400",
    "Accept-Ranges": "bytes",
    ...extraHeaders,
  });
  for (const name of ["content-length", "content-range"]) {
    const value = response.headers.get(name);
    if (value) res.set(name, value);
  }
  if (!response.body) return res.end();
  Readable.fromWeb(response.body).pipe(res);
  return undefined;
}

// Parses an upstream JSON reply, or returns null when the body is not JSON.
async function jsonOrNull(response) {
  const raw = await response.text();
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

router.get("/", async (req, res) => {
  res.set(corsHeaders);
  const { action, job_id, file_path, cdn_base_url, server_ip } = req.query;
  try {
    if (action === "media") {
      if (!job_id || !file_path) return badRequest(res, "job_id and file_path are required");
      if (!isAllowedServerIp(server_ip)) return badRequest(res, "server_ip not allowed");
      if (!isSafeRelativePath(String(file_path)) || !isSafeRelativePath(String(job_id)) || String(job_id).includes("/")) {
        return badRequest(res, "Invalid job_id or file_path");
      }
      const mediaUrl = `${externalApiBase(server_ip)}/player/jobs/${job_id}/${file_path}`;
      const ext = String(file_path).split(".").pop()?.toLowerCase() || "";
      return streamUpstream(req, res, mediaUrl, {
        notFoundMessage: { fetchFailed: "Upstream fetch failed", notFound: "Media not found" },
        extraHeaders: {},
        contentTypeFor: () => MEDIA_CONTENT_TYPES[ext] || "application/octet-stream",
      });
    }

    if (action === "cdn_proxy") {
      if (!job_id || !file_path || !cdn_base_url) {
        return badRequest(res, "job_id, file_path, and cdn_base_url are required");
      }
      // The original fetched any caller-supplied base URL. Only hosts in VIDEO_GEN_CDN_ALLOWED_HOSTS
      // (host or host:port, comma-separated) are allowed now; with the variable unset, nothing is.
      const allowedCdnHosts = (process.env.VIDEO_GEN_CDN_ALLOWED_HOSTS || "").split(",").map((h) => h.trim()).filter(Boolean);
      let cdnHost = null;
      try {
        cdnHost = new URL(String(cdn_base_url)).host;
      } catch {
        cdnHost = null;
      }
      if (!cdnHost || !allowedCdnHosts.includes(cdnHost)) return badRequest(res, "cdn_base_url not allowed");

      const cleanPath = String(file_path).replace(/^\/+/, "");
      const cleanBase = String(cdn_base_url).replace(/\/+$/, "");
      const cdnUrl = `${cleanBase}/${job_id}/${cleanPath}`;
      const ext = String(file_path).split(".").pop()?.toLowerCase() || "";
      return streamUpstream(req, res, cdnUrl, {
        notFoundMessage: { fetchFailed: "CDN fetch failed", notFound: "CDN resource not found" },
        extraHeaders: {},
        contentTypeFor: (response) => MEDIA_CONTENT_TYPES[ext] || response.headers.get("content-type") || "application/octet-stream",
      });
    }

    if (action && getHandlers[action]) return await getHandlers[action]({ req, res, query: req.query, h: H });
    return res.status(400).json({ error: "Invalid GET action" });
  } catch (error) {
    console.error("[video-generation-proxy] GET error:", error?.message);
    return res.status(500).json({ error: String(error) });
  }
});

router.post("/", async (req, res) => {
  res.set(corsHeaders);
  try {
    const body = req.body || {};
    const { action, job_id, server_ip, target_port, languages, speaker, tts_engine, avatar_id } = body;
    const skipAvatar = body.skip_avatar;
    const skipSection = body.skip_section_merge;
    const skipFinal = body.skip_final_merge;

    if (!isAllowedServerIp(server_ip) || !H.isValidPort(target_port)) {
      return badRequest(res, "server_ip or target_port not allowed");
    }

    const dynamicBase = externalApiBase(server_ip);
    const submitBase = target_port ? `http://${server_ip || defaultServerIp()}:${target_port}` : dynamicBase;

    if (!PUBLIC_POST_ACTIONS.has(action) && !authorise(req, res)) return undefined;

    if (postHandlers[action]) {
      return await postHandlers[action]({ body, req, res, h: H, submitBase, dynamicBase, server_ip, target_port, job_id });
    }

    if (!PORTED_POST_ACTIONS.has(action)) {
      return res.status(501).json({
        error: "not_ported",
        action: action ?? null,
        message: "This video-generation-proxy action is not ported to Express yet.",
      });
    }

    if (action === "status") {
      if (!job_id) return badRequest(res, "job_id is required");
      const statusBase = submitBase;
      const response = await fetch(`${statusBase}/job/${job_id}/status`);
      const data = await response.json();
      return res.json({ ...data, player_url: `${statusBase}/player_v2/?job=${job_id}` });
    }

    if (action === "avatar_status") {
      if (!job_id) return badRequest(res, "job_id is required");
      const response = await fetch(`${dynamicBase}/job/${job_id}/avatar_status`);
      const data = await response.json();
      return res.json({ ...data, http_status: response.status });
    }

    if (action === "dub_languages") {
      if (!job_id) return badRequest(res, "job_id is required");
      if (!Array.isArray(languages) || languages.length === 0) {
        return badRequest(res, "languages must be a non-empty array");
      }
      const response = await fetch(`${dynamicBase}/job/${job_id}/dub_languages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          languages,
          speaker: speaker || "abhilash",
          tts_engine: tts_engine || "edgetts",
          ...(avatar_id ? { avatar_id } : {}),
          skip_avatar: !!skipAvatar,
          skip_section_merge: !!skipSection,
          skip_final_merge: !!skipFinal,
        }),
      });
      const data = await jsonOrNull(response);
      if (data === null) {
        return res.status(502).json({
          error: `Dubbing server at ${dynamicBase} returned an invalid response (HTTP ${response.status}). ` +
            "The /job/<id>/dub_languages endpoint may not be deployed on this server yet.",
        });
      }
      return res.json(data);
    }

    if (action === "dub_status") {
      if (!job_id) return badRequest(res, "job_id is required");
      const response = await fetch(`${dynamicBase}/job/${job_id}/dub_status`);
      const data = await jsonOrNull(response);
      if (data === null) {
        return res.status(502).json({
          error: `Dubbing server at ${dynamicBase} returned an invalid response (HTTP ${response.status}). ` +
            "The /job/<id>/dub_status endpoint may not be deployed on this server yet.",
        });
      }
      return res.json(data);
    }

    if (action === "list_jobs") {
      const listBase = target_port ? submitBase : dynamicBase;
      const response = await fetch(`${listBase}/jobs`);
      const data = await response.json();
      if (job_id && data && Array.isArray(data.jobs)) {
        const match = data.jobs.find((j) => j.job_id === job_id);
        return res.json({ job: match || null });
      }
      return res.json(data);
    }

    if (action === "job_details") {
      if (!job_id) return badRequest(res, "job_id is required");
      try {
        const [statusResp, analyticsResp, avatarResp] = await Promise.all([
          fetch(`${dynamicBase}/job/${job_id}/status`).catch(() => null),
          fetch(`${dynamicBase}/jobs/${job_id}/analytics.json`).catch(() => null),
          fetch(`${dynamicBase}/jobs/${job_id}/avatar_status.json`).catch(() => null),
        ]);
        const jobStatus = statusResp?.ok ? await statusResp.json().catch(() => null) : null;
        const analytics = analyticsResp?.ok ? await analyticsResp.json().catch(() => null) : null;
        const avatarStatus = avatarResp?.ok ? await avatarResp.json().catch(() => null) : null;
        return res.status(200).json({ jobStatus, analytics, avatarStatus });
      } catch (e) {
        return res.status(500).json({ error: `Job details fetch error: ${e}` });
      }
    }

    return res.status(501).json({ error: "not_ported", action });
  } catch (error) {
    console.error("[video-generation-proxy] POST error:", error?.message);
    return res.status(500).json({ error: String(error?.message || error) });
  }
});

export default router;
