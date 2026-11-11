// Ported POST actions from supabase/functions/video-generation-proxy/index.ts:
//   submit, generate_avatar, retry_phase, rerender, regenerate_and_render.
// The dispatcher (../index.js) has already checked server_ip/target_port and the Authorization header.
// Every handler sends exactly one response through c.res.
import { query } from "../../_shared/db.js";
import { readFile } from "../../_shared/storage.js";
import { defaultServerIp, isSafeRelativePath, badRequest } from "../helpers.js";

// Bucket that holds uploaded question documents on this server's local storage.
const DOCUMENT_BUCKET = "uploaded-question-documents";
const B2_AUTHORIZE_URL = "https://api.backblazeb2.com/b2api/v2/b2_authorize_account";
const UPSTREAM_TIMEOUT_MS = 15000;

const MIME_TYPES = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  md: "text/markdown",
  html: "text/html",
  txt: "text/plain",
};

const getMimeType = (name) => {
  const ext = String(name || "").split(".").pop()?.toLowerCase();
  return MIME_TYPES[ext || ""] || "application/octet-stream";
};

const errorText = (err) => (err instanceof Error ? err.message : String(err));

// Marks a missing server configuration. The caller answers it with a plain 500 and no prefix.
class ConfigError extends Error {}

// Idempotency map for generate_avatar: duplicate submissions within 90 s are ignored.
const GENERATE_AVATAR_DEDUP_MS = 90_000;
const generateAvatarInflight = new Map();
function claimGenerateAvatar(key) {
  const now = Date.now();
  for (const [k, exp] of generateAvatarInflight) {
    if (exp <= now) generateAvatarInflight.delete(k);
  }
  const existing = generateAvatarInflight.get(key);
  if (existing && existing > now) return false;
  generateAvatarInflight.set(key, now + GENERATE_AVATAR_DEDUP_MS);
  return true;
}

// Reads a document for submit: local storage first, then Backblaze B2 for relative paths.
async function loadDocument(documentUrl, fileName) {
  const url = String(documentUrl);
  const mime = getMimeType(fileName || url);

  if (url.startsWith("http://") || url.startsWith("https://")) {
    // Only hosts listed in VIDEO_GEN_DOCUMENT_HOSTS may be fetched; with the variable unset, none are.
    const allowedHosts = (process.env.VIDEO_GEN_DOCUMENT_HOSTS || "").split(",").map((h) => h.trim()).filter(Boolean);
    let host = null;
    try {
      host = new URL(url).host;
    } catch {
      host = null;
    }
    if (!host || !allowedHosts.includes(host)) throw new Error("document host not allowed");
    console.log("[submit] Full URL path, downloading directly...");
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Failed to download document: ${r.status}`);
    return new Blob([await r.arrayBuffer()], { type: mime });
  }

  if (!isSafeRelativePath(url)) throw new Error("invalid document path");
  try {
    const bytes = await readFile(DOCUMENT_BUCKET, url);
    console.log(`[submit] File read from local storage: ${bytes.byteLength} bytes, MIME: ${mime}`);
    return new Blob([bytes], { type: mime });
  } catch (e) {
    if (e?.code !== "ENOENT" && e?.message !== "invalid storage path") throw e;
  }

  console.log("[submit] B2 path detected, authorizing...");
  const keyId = process.env.B2_KEY_ID;
  const appKey = process.env.B2_APPLICATION_KEY;
  const bucketName = process.env.B2_BUCKET_NAME;
  if (!keyId || !appKey || !bucketName) {
    throw new ConfigError("B2 credentials not configured for document download");
  }
  const authResp = await fetch(B2_AUTHORIZE_URL, {
    headers: { Authorization: "Basic " + Buffer.from(`${keyId}:${appKey}`).toString("base64") },
  });
  if (!authResp.ok) throw new Error("B2 authorization failed");
  const b2Auth = await authResp.json();

  const fileResp = await fetch(`${b2Auth.downloadUrl}/file/${bucketName}/${url}`, {
    headers: { Authorization: b2Auth.authorizationToken },
  });
  if (!fileResp.ok) throw new Error(`Failed to download document from B2: ${fileResp.status}`);
  return new Blob([await fileResp.arrayBuffer()], { type: mime });
}

async function submitStory(c) {
  const { body, res, submitBase } = c;
  const { story_hint, subject, grade, dry_run, skip_wan, skip_avatar, skip_threejs, llm_routing } = body;
  const { tts_provider, pipeline_version, generation_scope, video_provider, ocr_provider, avatar_language, avatar_speaker } = body;

  if (!story_hint || typeof story_hint !== "string" || story_hint.trim().length < 10) {
    return badRequest(res, "story_hint is required (30-100 words recommended)");
  }

  const storyForm = new FormData();
  // A generated markdown file lets the server's "file or markdown" validator pass.
  const storyMarkdown = `# Story Mode\n\n${story_hint}\n`;
  storyForm.append("file", new Blob([storyMarkdown], { type: "text/markdown" }), "story.md");
  storyForm.append("subject", subject || "General Science");
  storyForm.append("grade", String(grade || "12"));
  storyForm.append("dry_run", String(dry_run ?? false));
  storyForm.append("skip_wan", String(skip_wan ?? false));
  storyForm.append("skip_avatar", String(skip_avatar ?? false));
  storyForm.append("audio_only", String(body.audio_only ?? false));
  storyForm.append("reel_with_avatar", String(body.reel_with_avatar ?? true));
  storyForm.append("tts_provider", tts_provider || "our_tts");
  storyForm.append("pipeline_version", pipeline_version || "v3");
  storyForm.append("generation_scope", generation_scope || "full");
  storyForm.append("video_provider", video_provider || "kie");
  storyForm.append("ocr_provider", ocr_provider || "local");
  storyForm.append("skip_threejs", String(skip_threejs ?? false));
  const defaultRouting = {
    chunker: "openrouter", director: "openrouter",
    manim_renderer: "openrouter", remotion_renderer: "openrouter",
    video_renderer: "openrouter", prompt_enhancer: "openrouter",
  };
  const routing = llm_routing ?? defaultRouting;
  storyForm.append("llm_routing", typeof routing === "string" ? routing : JSON.stringify(routing));
  storyForm.append("avatar_language", avatar_language || "english");
  if (avatar_speaker) storyForm.append("avatar_speaker", String(avatar_speaker));
  storyForm.append("reel_variant", "story");
  storyForm.append("story_hint", story_hint);
  storyForm.append("image_provider", "gpu");
  storyForm.append("image_model", "flux_dev");

  console.log(`[submit:story] Posting to ${submitBase}/submit_job`);
  try {
    const response = await fetch(`${submitBase}/submit_job`, { method: "POST", body: storyForm });
    const data = await response.json();
    console.log("[submit:story] Server response:", JSON.stringify(data));
    return res.status(response.status).json(data);
  } catch (err) {
    console.error("[submit:story] fetch error:", err);
    // The original answered 200 here (no status set), with an error body.
    return res.status(200).json({ status: "error", error: `Story server unreachable: ${errorText(err)}` });
  }
}

async function submit(c) {
  const { body, res, submitBase } = c;
  if (body.reel_variant === "story") return submitStory(c);

  const {
    markdown, subject, grade, tts_provider, pipeline_version, document_url, file_name, job_prefix,
    audio_only, reel_with_avatar, reel_variant, ocr_provider, skip_threejs, llm_routing,
    avatar_language, video_provider, skip_wan, skip_avatar, dry_run, generation_scope,
    no_quiz, image_provider, image_model, avatar_id, avatar_speaker,
  } = body;

  console.log(`[submit] Received: document_url=${document_url || "NONE"}, file_name=${file_name || "NONE"}, markdown_length=${markdown ? markdown.length : 0}`);

  let fileBlob;
  let uploadFileName;
  if (document_url) {
    try {
      fileBlob = await loadDocument(document_url, file_name);
      uploadFileName = file_name || "document";
    } catch (dlErr) {
      console.error("[submit] Document download error:", dlErr);
      if (dlErr instanceof ConfigError) return res.status(500).json({ error: dlErr.message });
      return res.status(500).json({
        error: `Failed to download original document: ${errorText(dlErr)}. Try re-uploading the document.`,
      });
    }
  } else if (markdown) {
    fileBlob = new Blob([markdown], { type: "text/markdown" });
    uploadFileName = "document.md";
  } else {
    return badRequest(res, "Either document_url or markdown content is required");
  }

  const formData = new FormData();
  formData.append("file", fileBlob, uploadFileName);
  formData.append("subject", subject || "General Science");
  if (grade) formData.append("grade", String(grade));
  formData.append("tts_provider", tts_provider || "our_tts");
  formData.append("pipeline_version", pipeline_version || "v15_v2_director");
  formData.append("video_provider", video_provider || "kie");
  formData.append("skip_wan", String(skip_wan ?? false));
  formData.append("skip_avatar", String(skip_avatar ?? false));
  formData.append("dry_run", String(dry_run ?? false));
  formData.append("generation_scope", generation_scope || "full");
  formData.append("image_provider", image_provider || "gpu");
  formData.append("image_model", image_model || "flux_dev");
  if (no_quiz !== undefined) formData.append("no_quiz", String(no_quiz));
  if (avatar_speaker) formData.append("avatar_speaker", String(avatar_speaker));

  let resolvedAvatarId = "";
  if (avatar_id !== undefined && avatar_id !== null) {
    resolvedAvatarId = String(avatar_id).trim();
  } else if (subject) {
    try {
      // maybeSingle() semantics: only a single matching subject counts.
      const { rows } = await query(
        "SELECT avatar_id FROM public.popular_subjects WHERE name ILIKE $1 LIMIT 2",
        [String(subject).trim()],
      );
      if (rows.length === 1 && rows[0].avatar_id) resolvedAvatarId = String(rows[0].avatar_id).trim();
    } catch (err) {
      console.warn("[video-generation-proxy] Failed to resolve avatar_id from popular_subjects:", err);
    }
  }
  // Global fallback avatar, used only when avatar_id was omitted completely.
  if (!resolvedAvatarId && avatar_id === undefined) resolvedAvatarId = "avatar_5ab07dea";

  formData.append("avatar_id", resolvedAvatarId);
  console.log(`[video-generation-proxy:submit] subject="${subject}", raw_avatar_id="${avatar_id}", resolved_avatar_id="${resolvedAvatarId}", port=${c.target_port}`);

  // Reel-mode optional fields, appended only when provided.
  if (audio_only !== undefined) formData.append("audio_only", String(audio_only));
  if (reel_with_avatar !== undefined) formData.append("reel_with_avatar", String(reel_with_avatar));
  if (reel_variant !== undefined) formData.append("reel_variant", String(reel_variant));
  if (ocr_provider !== undefined) formData.append("ocr_provider", String(ocr_provider));
  if (skip_threejs !== undefined) formData.append("skip_threejs", String(skip_threejs));
  if (avatar_language !== undefined) formData.append("avatar_language", String(avatar_language));
  if (llm_routing !== undefined) {
    formData.append("llm_routing", typeof llm_routing === "string" ? llm_routing : JSON.stringify(llm_routing));
  }
  if (job_prefix) formData.append("job_prefix", job_prefix);

  console.log(`[submit] Posting to: ${submitBase}/submit_job`);
  try {
    const response = await fetch(`${submitBase}/submit_job`, { method: "POST", body: formData });
    console.log(`[submit] Server response status: ${response.status}`);
    const data = await response.json();
    return res.status(200).json(data);
  } catch (fetchErr) {
    console.error("Submit fetch error:", fetchErr);
    return res.status(200).json({
      status: "error",
      error: `Server unreachable. The video generation server may be down. Details: ${errorText(fetchErr)}`,
    });
  }
}

async function generate_avatar(c) {
  const { res, job_id, server_ip, dynamicBase } = c;
  if (!job_id) return badRequest(res, "job_id is required");

  const dedupKey = `${job_id}::${server_ip || defaultServerIp()}`;
  if (!claimGenerateAvatar(dedupKey)) {
    console.warn(`[generate_avatar] Duplicate submission blocked for ${dedupKey} (within ${GENERATE_AVATAR_DEDUP_MS}ms)`);
    return res.status(200).json({
      status: "duplicate_ignored",
      message: `A generate_avatar request for ${job_id} was already submitted within the last ${GENERATE_AVATAR_DEDUP_MS / 1000}s. Ignoring duplicate to prevent parallel runs that corrupt presentation.json.`,
      job_id,
    });
  }

  console.log(`[generate_avatar] Starting avatar generation for job: ${job_id} on server: ${server_ip || defaultServerIp()}`);
  const response = await fetch(`${dynamicBase}/job/${job_id}/generate_avatar`, { method: "POST" });
  const data = await response.json();
  console.log("Avatar generation response:", data);
  return res.status(200).json(data);
}

// POSTs to an upstream with a 15 s budget. Resolves to one of:
//   { response, data }        the upstream answered (data is parsed JSON, or { raw_response })
//   { timedOut: true }        the budget ran out (AbortError)
//   { networkError: string }  the request failed for another reason
async function callUpstream(url, requestBody) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    clearTimeout(timer);
    let text = "";
    let data;
    try {
      text = await response.text();
      data = JSON.parse(text);
    } catch {
      console.log(`Upstream response is not JSON: ${text.substring(0, 500)}`);
      data = { raw_response: text.substring(0, 500) };
    }
    return { response, data };
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") return { timedOut: true };
    return { networkError: err instanceof Error ? err.message : "Unknown error" };
  }
}

// Finishes a slow upstream call after the client has already received 202. Failures are only logged.
function finishInBackground(label, url, requestBody) {
  (async () => {
    try {
      console.log(`[${label}] Background: Starting delayed request for ${url}`);
      const bgResponse = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const bgText = await bgResponse.text();
      if (!bgResponse.ok) console.error(`[${label}] Background: FAILED - HTTP ${bgResponse.status}`, bgText.substring(0, 500));
      else console.log(`[${label}] Background: completed - HTTP ${bgResponse.status}`);
    } catch (bgError) {
      console.error(`[${label}] Background: Network error:`, bgError);
    }
  })();
}

async function retry_phase(c) {
  const { body, res, job_id, dynamicBase } = c;
  if (!job_id) return badRequest(res, "job_id is required");

  const { phase, section_ids, user_feedback } = body;
  if (!phase) {
    return badRequest(res, "phase is required. Valid phases: manim_codegen, manim_render, avatar_generation, wan_render, tts_generation");
  }
  const validPhases = ["manim_codegen", "manim_render", "avatar_generation", "wan_render", "video_render", "tts_generation"];
  if (!validPhases.includes(phase)) {
    return badRequest(res, `Invalid phase: ${phase}. Valid phases: ${validPhases.join(", ")}`);
  }

  console.log(`[RETRY_PHASE] Retrying phase '${phase}' for job: ${job_id}`);
  const requestBody = { phase };
  if (Array.isArray(section_ids) && section_ids.length > 0) requestBody.section_ids = section_ids;
  if (typeof user_feedback === "string" && user_feedback.trim()) requestBody.user_feedback = user_feedback.trim();

  const url = `${dynamicBase}/job/${job_id}/retry_phase`;
  const out = await callUpstream(url, requestBody);
  const sections = section_ids || "all";

  if (out.timedOut) {
    finishInBackground("RETRY_PHASE", url, requestBody);
    return res.status(202).json({
      status: "accepted",
      message: `Phase '${phase}' regeneration started (upstream slow, processing in background)`,
      phase,
      job_id,
      section_ids: sections,
      timeout: true,
    });
  }
  if (out.networkError !== undefined) {
    return res.status(502).json({
      status: "error",
      error: `Failed to reach upstream: ${out.networkError}`,
      phase,
      job_id,
      section_ids: sections,
    });
  }

  const { response, data } = out;
  if (!response.ok) {
    console.error(`[RETRY_PHASE] Upstream error: ${response.status}`, data);
    return res.status(response.status).json({
      status: "error",
      error: `Upstream returned ${response.status}`,
      upstream_status: response.status,
      upstream_body: data,
      phase,
      job_id,
      section_ids: sections,
    });
  }
  return res.status(200).json({
    status: "accepted",
    message: `Phase '${phase}' regeneration confirmed by upstream`,
    upstream_response: data,
    phase,
    job_id,
    section_ids: sections,
  });
}

// Shared flow for rerender and regenerate_and_render. Upstream refusals are answered with 200 and status "error".
async function relayJobCall(c, { label, path, requestBody, sectionIds, startedMessage, timeoutMessage }) {
  const { res, job_id, dynamicBase } = c;
  const url = `${dynamicBase}/${path}`;
  console.log(`[${label}] Calling ${url} with body:`, JSON.stringify(requestBody));
  const out = await callUpstream(url, requestBody);

  if (out.timedOut) {
    finishInBackground(label, url, requestBody);
    return res.status(202).json({
      status: "accepted",
      message: timeoutMessage,
      job_id,
      section_ids: sectionIds,
      timeout: true,
    });
  }
  if (out.networkError !== undefined) {
    return res.status(502).json({
      status: "error",
      error: `Failed to reach upstream: ${out.networkError}`,
      job_id,
      section_ids: sectionIds,
    });
  }

  const { response, data } = out;
  if (!response.ok) {
    console.error(`[${label}] Upstream error: ${response.status}`, data);
    const upstreamError = data?.error || data?.message || `Upstream returned ${response.status}`;
    return res.status(200).json({
      status: "error",
      error: upstreamError,
      upstream_status: response.status,
      job_id,
      section_ids: sectionIds,
    });
  }
  return res.status(200).json({
    status: "accepted",
    message: startedMessage,
    upstream_response: data,
    job_id,
    section_ids: sectionIds,
  });
}

async function rerender(c) {
  const { body, res, job_id } = c;
  if (!job_id) return badRequest(res, "job_id is required");

  const { section_ids } = body;
  if (!section_ids || !Array.isArray(section_ids) || section_ids.length === 0) {
    return badRequest(res, "section_ids is required and must be a non-empty array");
  }

  return relayJobCall(c, {
    label: "RERENDER",
    path: `jobs/${job_id}/rerender`,
    requestBody: { section_ids },
    sectionIds: section_ids,
    startedMessage: `Rerender started for ${section_ids.length} section(s)`,
    timeoutMessage: "Rerender started (upstream slow, processing in background)",
  });
}

async function regenerate_and_render(c) {
  const { body, res, job_id } = c;
  if (!job_id) return badRequest(res, "job_id is required");

  const { section_ids, renderers, execute, skip_wan, dry_run } = body;
  if (!section_ids || !Array.isArray(section_ids) || section_ids.length === 0) {
    return badRequest(res, "section_ids is required and must be a non-empty array of integers");
  }

  const requestBody = { section_ids };
  if (renderers && Array.isArray(renderers)) requestBody.renderers = renderers;
  if (execute !== undefined) requestBody.execute = execute;
  if (skip_wan !== undefined) requestBody.skip_wan = skip_wan;
  if (dry_run !== undefined) requestBody.dry_run = dry_run;

  return relayJobCall(c, {
    label: "REGEN_AND_RENDER",
    path: `jobs/${job_id}/regenerate_and_render`,
    requestBody,
    sectionIds: section_ids,
    startedMessage: `Regenerate and render started for ${section_ids.length} section(s)`,
    timeoutMessage: "Regenerate and render started (upstream slow, processing in background)",
  });
}

// Any error that escapes a handler becomes the original's 500 {error}, unless a response was already sent.
const guarded = (fn) => async (c) => {
  try {
    return await fn(c);
  } catch (err) {
    console.error(`[video-generation-proxy] ${fn.name} error:`, err);
    if (!c.res.headersSent) return c.res.status(500).json({ error: errorText(err) });
    return undefined;
  }
};

export const handlers = {
  submit: guarded(submit),
  retry_phase: guarded(retry_phase),
  rerender: guarded(rerender),
  regenerate_and_render: guarded(regenerate_and_render),
  generate_avatar: guarded(generate_avatar),
};

export const getHandlers = {};
