// Port of supabase/functions/marketing-video-proxy. Marketing video pipeline only: submit a document
// (or markdown) and read job status. Kept apart from the lecture and reel proxies.
// Env: MARKETING_VIDEO_HOST (the pipeline server; required, no default), MARKETING_VIDEO_PORT
// (default 5006), B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_ID, B2_BUCKET_NAME (for private B2 files).
// Auth: Bearer user token, or Bearer equal to SERVICE_KEY.
// Security: the original let the caller choose server_ip and target_port. Here the caller may only
// name the configured MARKETING_VIDEO_HOST, so the proxy cannot be pointed at other hosts.
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";
import { readFile } from "../_shared/storage.js";

export const router = express.Router();

// Test hook: lets tests stub outbound HTTP so no real request is sent.
export const hooks = { fetch: (...args) => fetch(...args) };

const DEFAULT_PORT = 5006;
const DOCUMENT_BUCKET = "uploaded-question-documents";

const MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  md: "text/markdown",
  txt: "text/plain",
  html: "text/html",
};

export function normalizeTargetLanguages(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const joined = value.map(String).filter(Boolean).join(",");
    return joined || null;
  }
  const asString = String(value).trim();
  if (!asString || asString.toLowerCase() === "null") return null;
  return asString;
}

export function getMimeType(name) {
  const ext = (name || "").split(".").pop()?.toLowerCase() || "";
  return MIME[ext] || "application/octet-stream";
}

export function normalizeB2Path(filePath) {
  return filePath
    .split("/")
    .map((segment) => {
      try {
        return encodeURIComponent(decodeURIComponent(segment));
      } catch {
        return encodeURIComponent(segment);
      }
    })
    .join("/");
}

async function verifyAuth(req) {
  const token = (req.get("Authorization") || "").replace("Bearer ", "");
  if (!token) return { ok: false, status: 401, msg: "Missing token" };
  const svc = process.env.SERVICE_KEY || "";
  if (svc && token === svc) return { ok: true };
  try {
    return jwt.verify(token, process.env.JWT_SECRET)?.sub ? { ok: true } : { ok: false, status: 401, msg: "Invalid token" };
  } catch {
    return { ok: false, status: 401, msg: "Invalid token" };
  }
}

async function fetchBlob(url, fileName) {
  const r = await hooks.fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!r.ok) throw new Error(`download failed: ${r.status}`);
  return new Blob([await r.arrayBuffer()], { type: getMimeType(fileName || url) });
}

async function downloadDocument(documentUrl, fileName) {
  if (documentUrl.startsWith("http://") || documentUrl.startsWith("https://")) {
    return fetchBlob(documentUrl, fileName);
  }

  // Files uploaded to this server's storage.
  try {
    const bytes = await readFile(DOCUMENT_BUCKET, documentUrl);
    return new Blob([bytes], { type: getMimeType(fileName || documentUrl) });
  } catch (e) {
    if (e?.code !== "ENOENT" && e?.message !== "invalid storage path") throw e;
  }

  // Fallback for AI documents that live only in private Backblaze B2.
  let { rows } = await query("SELECT file_path FROM public.storage_files WHERE file_path = $1 LIMIT 1", [documentUrl]);
  let b2Record = rows[0];
  if (!b2Record && fileName) {
    ({ rows } = await query(
      "SELECT file_path FROM public.storage_files WHERE file_name = $1 ORDER BY created_at DESC LIMIT 1",
      [fileName],
    ));
    b2Record = rows[0];
  }
  return downloadFromB2(b2Record?.file_path || documentUrl, fileName || documentUrl);
}

async function downloadFromB2(filePath, fallbackName) {
  const keyId = process.env.B2_KEY_ID;
  const appKey = process.env.B2_APPLICATION_KEY;
  const bucketId = process.env.B2_BUCKET_ID;
  const bucketName = process.env.B2_BUCKET_NAME;
  if (!keyId || !appKey || !bucketId || !bucketName) {
    throw new Error("B2 credentials not configured for marketing document download");
  }

  const authResp = await hooks.fetch("https://api.backblazeb2.com/b2api/v2/b2_authorize_account", {
    headers: { Authorization: "Basic " + Buffer.from(`${keyId}:${appKey}`).toString("base64") },
  });
  if (!authResp.ok) throw new Error(`B2 authorization failed: ${authResp.status}`);
  const auth = await authResp.json();

  const encodedPath = normalizeB2Path(filePath);
  const dlAuthResp = await hooks.fetch(`${auth.apiUrl}/b2api/v2/b2_get_download_authorization`, {
    method: "POST",
    headers: { Authorization: auth.authorizationToken, "Content-Type": "application/json" },
    body: JSON.stringify({ bucketId, fileNamePrefix: encodedPath, validDurationInSeconds: 3600 }),
  });
  if (!dlAuthResp.ok) throw new Error(`B2 download authorization failed: ${dlAuthResp.status}`);
  const dlAuth = await dlAuthResp.json();

  const b2Url = `${auth.downloadUrl}/file/${bucketName}/${encodedPath}?Authorization=${dlAuth.authorizationToken}`;
  const resp = await hooks.fetch(b2Url, { signal: AbortSignal.timeout(300_000) });
  if (!resp.ok) throw new Error(`B2 document download failed: ${resp.status}`);
  return new Blob([await resp.arrayBuffer()], { type: getMimeType(fallbackName) });
}

// Returns the pipeline base URL, or throws when it is not configured.
function pipelineBase(requested) {
  const host = process.env.MARKETING_VIDEO_HOST;
  if (!host) throw new Error("MARKETING_VIDEO_HOST is not configured");
  if (requested && requested !== host) {
    const err = new Error("server_ip is not allowed");
    err.status = 400;
    throw err;
  }
  const port = Number(process.env.MARKETING_VIDEO_PORT) || DEFAULT_PORT;
  return `http://${host}:${port}`;
}

router.post("/", async (req, res) => {
  try {
    const auth = await verifyAuth(req);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.msg });

    const body = req.body || {};
    const {
      action, job_id, server_ip, target_port,
      document_url, file_name, markdown,
      subject, grade, job_prefix, title,
      tts_provider, pipeline_version, video_provider, image_provider, image_model,
      no_quiz, avatar_speaker, avatar_language, avatar_id, ocr_provider, skip_threejs,
      skip_wan, skip_avatar, dry_run, generation_scope, llm_routing,
      audio_only, model, target_languages, reel_with_avatar, reel_variant, story_hint,
      tts_engine,
    } = body;

    let base;
    try {
      base = pipelineBase(server_ip);
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message });
    }
    if (target_port !== undefined && Number(target_port) !== Number(process.env.MARKETING_VIDEO_PORT || DEFAULT_PORT)) {
      return res.status(400).json({ error: "target_port is not allowed" });
    }

    if (action === "submit") {
      console.log(`[marketing:submit] doc=${file_name || "markdown"}`);
      let fileBlob;
      let uploadName;
      if (document_url) {
        fileBlob = await downloadDocument(document_url, file_name);
        uploadName = file_name || "document";
      } else if (markdown) {
        fileBlob = new Blob([markdown], { type: "text/markdown" });
        uploadName = "document.md";
      } else {
        return res.status(400).json({ error: "document_url or markdown required" });
      }

      const fd = new FormData();
      fd.append("file", fileBlob, uploadName);
      fd.append("subject", subject || "General Science");
      fd.append("grade", String(grade || "9"));
      fd.append("tts_provider", tts_provider || "edge_tts");
      fd.append("pipeline_version", pipeline_version || "v3_visual_first");
      fd.append("video_provider", video_provider || "kie");
      fd.append("image_provider", image_provider || "gpu");
      fd.append("image_model", image_model || "flux_dev");
      fd.append("skip_wan", String(skip_wan ?? false));
      fd.append("skip_avatar", String(skip_avatar ?? false));
      fd.append("audio_only", String(audio_only ?? false));
      fd.append("dry_run", String(dry_run ?? false));
      fd.append("generation_scope", generation_scope || "full");
      fd.append("no_quiz", String(no_quiz ?? true));
      if (model) fd.append("model", String(model));
      if (title) fd.append("title", String(title));
      const normalizedTargetLanguages = normalizeTargetLanguages(target_languages);
      if (normalizedTargetLanguages) fd.append("target_languages", normalizedTargetLanguages);
      if (reel_with_avatar !== undefined) fd.append("reel_with_avatar", String(reel_with_avatar));
      if (reel_variant) fd.append("reel_variant", String(reel_variant));
      if (story_hint) fd.append("story_hint", String(story_hint));
      if (avatar_language) fd.append("avatar_language", String(avatar_language));
      const effectiveTtsEngine =
        tts_engine && String(tts_engine).toLowerCase() !== "default" ? String(tts_engine).toLowerCase() : "";
      if (effectiveTtsEngine) fd.append("tts_engine", effectiveTtsEngine);
      // IndicF5 clones avatar reference audio, so the speaker is left out (matches HeyGem routing).
      if (effectiveTtsEngine !== "indicf5" && avatar_speaker) fd.append("avatar_speaker", String(avatar_speaker));

      let resolvedAvatarId = "";
      if (avatar_id !== undefined && avatar_id !== null) {
        resolvedAvatarId = String(avatar_id).trim();
      } else if (subject) {
        try {
          const { rows } = await query(
            "SELECT avatar_id FROM public.popular_subjects WHERE name ILIKE $1 LIMIT 1",
            [String(subject).trim()],
          );
          if (rows[0]?.avatar_id) resolvedAvatarId = String(rows[0].avatar_id).trim();
        } catch (e) {
          console.warn("[marketing-video-proxy] Unable to resolve subject avatar_id:", e?.message);
        }
      }
      fd.append("avatar_id", resolvedAvatarId);
      if (ocr_provider) fd.append("ocr_provider", String(ocr_provider));
      if (skip_threejs !== undefined) fd.append("skip_threejs", String(skip_threejs));
      if (llm_routing !== undefined) {
        fd.append("llm_routing", typeof llm_routing === "string" ? llm_routing : JSON.stringify(llm_routing));
      }
      if (job_prefix) fd.append("job_prefix", job_prefix);

      try {
        const resp = await hooks.fetch(`${base}/submit_job`, {
          method: "POST",
          body: fd,
          signal: AbortSignal.timeout(300_000),
        });
        const data = await resp.json().catch(() => ({}));
        return res.status(resp.ok ? 200 : resp.status).json(data);
      } catch (e) {
        console.error("[marketing:submit] error", e?.message);
        return res.json({
          status: "error",
          error: `Marketing server unreachable. ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }

    if (action === "status") {
      if (!job_id) return res.status(400).json({ error: "job_id required" });
      try {
        const resp = await hooks.fetch(`${base}/job/${encodeURIComponent(job_id)}/status`, {
          signal: AbortSignal.timeout(60_000),
        });
        const data = await resp.json().catch(() => ({}));
        return res.json({ ...data, player_url: `${base}/player_v2/?job=${encodeURIComponent(job_id)}` });
      } catch (e) {
        return res.json({
          status: "error",
          error: `Marketing status unreachable: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }

    return res.status(400).json({ error: `Unsupported action: ${action}` });
  } catch (e) {
    console.error("[marketing-video-proxy] fatal", e?.message);
    res.status(500).json({ error: String(e?.message || e) });
  }
});
