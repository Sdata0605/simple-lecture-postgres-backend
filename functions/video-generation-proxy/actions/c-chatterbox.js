// Ported video-generation-proxy actions (reference: reference/supabase-functions/video-generation-proxy/index.ts).
//   GET  vimeo_proxy                         (reference GET block, ~lines 325-712)
//   GET  chatterbox_proxy                    (reference GET block, ~lines 713-828; also POST below)
//   POST chatterbox_proxy                    (same streamer, task_id and server_ip read from the body)
//   POST chatterbox_generate, chatterbox_status, chatterbox_library   (~lines 2466-2640)
//   POST multilang_generate_avatar, multilang_avatar_status           (~lines 2876-3057)
//   POST save_language_avatar_to_cdn                                  (~lines 3058-3141)
// Env:
//   VIMEO_ACCESS_TOKEN          optional. Without it vimeo_proxy falls back to scraping and reports the gap on failure.
//   VIDEO_GEN_DEFAULT_SERVER_IP default GPU server. Required when a request has no server_ip (500 otherwise).
//   VIDEO_GEN_CLOUD_SERVER_IP   optional. The cloud GPU server; its 404 on avatar_status is terminal.
// Upstream ports: Chatterbox 5004, V2.5 multi-language API 5005 (both on the same server IP).
import { mkdir, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import { Readable } from "node:stream";
import { badRequest, defaultServerIp, isAllowedServerIp, isSafeRelativePath } from "../helpers.js";

const CHATTERBOX_PORT = 5004;
const V25_PORT = 5005;
// The Deno function wrote language avatars under the absolute path /video. That path only exists on the GPU host, so
// the root now comes from VIDEO_OUTPUT_ROOT and the action refuses to write when it is unset.
const SAFE_LANGUAGE = /^[A-Za-z][A-Za-z_-]{0,39}$/;
const SAFE_SECTION_ID = /^\d{1,6}$/;
// The reference used a Chrome version that was redacted in this copy. Any current desktop Chrome string works here.
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const chatterboxBase = (ip) => `http://${ip}:${CHATTERBOX_PORT}`;
const v25Base = (ip) => `http://${ip}:${V25_PORT}`;
const resolveIp = (serverIp) => serverIp || defaultServerIp();
const noServer = (res) => res.status(500).json({ error: "VIDEO_GEN_DEFAULT_SERVER_IP not configured" });

// An id that is placed into a path segment: non-empty, no traversal, no slashes.
function isSafeId(value) {
  const s = String(value);
  return s.length > 0 && s !== "." && !s.includes("/") && isSafeRelativePath(s);
}

// Same retry policy as the reference: retries only on connection errors, waiting 1s, 2s, 4s.
async function fetchWithRetry(url, options, maxRetries = 3) {
  let lastError = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries - 1) await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
    }
  }
  throw lastError;
}

function copyStreamHeaders(upstream, res) {
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) res.set("Content-Length", contentLength);
  const contentRange = upstream.headers.get("content-range");
  if (contentRange) res.set("Content-Range", contentRange);
}

// ---------- vimeo_proxy (GET) ----------

const browserHeaders = (referer = "https://vimeo.com/") => ({
  "User-Agent": BROWSER_UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "cross-site",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
  Referer: referer,
  Origin: "https://vimeo.com",
  Cookie: `vuid=pl${Date.now()}.${Math.random().toString(36).substring(2)}`,
});

const bestProgressive = (progressive) => {
  const sorted = progressive.filter((f) => f.url).sort((a, b) => (b.height || 0) - (a.height || 0));
  return sorted.length > 0 ? { url: sorted[0].url, quality: sorted[0].quality || `${sorted[0].height}p` } : null;
};

// Unescapes a config_url found in player HTML.
const decodeConfigUrl = (raw) => raw.replace(/\\u002F/g, "/").replace(/\\u0026/g, "&").replace(/\\/g, "");

// Fetches a Vimeo player config and returns its best progressive MP4, or null.
async function mp4FromConfig(configUrl, debug) {
  const configRes = await fetch(configUrl, {
    headers: { ...browserHeaders("https://player.vimeo.com/"), Accept: "application/json" },
  });
  if (!debug.config_status) debug.config_status = configRes.status;
  if (!configRes.ok) return null;
  const configData = await configRes.json();
  return bestProgressive(configData?.request?.files?.progressive || []);
}

// Reads the "progressive" array embedded in player HTML, or returns null.
function mp4FromHtml(html) {
  const match = html.match(/"progressive"\s*:\s*\[([\s\S]*?)\]/);
  if (!match) return null;
  try {
    return bestProgressive(JSON.parse(`[${match[1]}]`));
  } catch {
    return null;
  }
}

const CONFIG_URL_RE = /"config_url"\s*:\s*"([^"]+)"/;

async function vimeoProxy({ req, res, query }) {
  if (!query.vimeo_id) return badRequest(res, "vimeo_id is required");
  const id = encodeURIComponent(String(query.vimeo_id));
  const VIMEO_TOKEN = process.env.VIMEO_ACCESS_TOKEN;
  const debug = {};
  let mp4Link = null;
  let quality = "unknown";

  // Method 0: Vimeo API (needs VIMEO_ACCESS_TOKEN)
  if (VIMEO_TOKEN) {
    try {
      const apiRes = await fetch(`https://api.vimeo.com/videos/${id}?fields=download,files,privacy,embed,name`, {
        headers: { Authorization: `Bearer ${VIMEO_TOKEN}`, Accept: "application/vnd.vimeo.*+json;version=3.4" },
      });
      debug.api_status = apiRes.status;
      if (apiRes.ok) {
        const vimeoData = await apiRes.json();
        const downloads = vimeoData.download || [];
        if (downloads.length > 0) {
          const mp4Downloads = downloads
            .filter((d) => d.link && (d.type === "video/mp4" || d.link.includes(".mp4")))
            .sort((a, b) => (b.height || 0) - (a.height || 0));
          if (mp4Downloads.length > 0) {
            mp4Link = mp4Downloads[0].link;
            quality = mp4Downloads[0].quality || `${mp4Downloads[0].height}p`;
          }
        }
        if (!mp4Link) {
          const files = vimeoData.files || [];
          const progressiveFile = files
            .filter((f) => f.quality && f.type === "video/mp4")
            .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
          if (progressiveFile?.link) {
            mp4Link = progressiveFile.link;
            quality = progressiveFile.quality || `${progressiveFile.height}p`;
          }
        }
        if (!mp4Link) {
          debug.api_downloads = downloads.length;
          debug.api_files = (vimeoData.files || []).length;
        }
      }
    } catch (e) {
      debug.api_error = String(e);
    }
  }

  // Method 1: oEmbed -> player iframe -> config_url or embedded progressive list
  if (!mp4Link) {
    try {
      const oembedRes = await fetch(`https://vimeo.com/api/oembed.json?url=https://vimeo.com/${id}`, {
        headers: browserHeaders(),
      });
      debug.oembed_status = oembedRes.status;
      if (oembedRes.ok) {
        const oembedData = await oembedRes.json();
        const htmlMatch = oembedData.html?.match(/src="([^"]+)"/);
        if (htmlMatch) {
          const iframeSrc = htmlMatch[1].replace(/&amp;/g, "&");
          const playerRes = await fetch(iframeSrc, { headers: browserHeaders("https://vimeo.com/") });
          debug.player_status = playerRes.status;
          if (playerRes.ok) {
            const html = await playerRes.text();
            const configMatch = html.match(CONFIG_URL_RE);
            if (configMatch) {
              const result = await mp4FromConfig(decodeConfigUrl(configMatch[1]), debug);
              if (result) ({ url: mp4Link, quality } = result);
            }
            if (!mp4Link) {
              const result = mp4FromHtml(html);
              if (result) ({ url: mp4Link, quality } = result);
            }
          }
        }
      }
    } catch {
      // fall through to the next method, as the reference does
    }
  }

  // Method 2: player embed page
  if (!mp4Link) {
    try {
      const embedRes = await fetch(`https://player.vimeo.com/video/${id}`, { headers: browserHeaders("https://vimeo.com/") });
      debug.embed_status = embedRes.status;
      if (embedRes.ok) {
        const html = await embedRes.text();
        const configMatch = html.match(CONFIG_URL_RE);
        if (configMatch) {
          const result = await mp4FromConfig(decodeConfigUrl(configMatch[1]), debug);
          if (result) ({ url: mp4Link, quality } = result);
        }
        if (!mp4Link) {
          const result = mp4FromHtml(html);
          if (result) ({ url: mp4Link, quality } = result);
        }
      }
    } catch {
      // fall through
    }
  }

  // Method 3: direct player config endpoint
  if (!mp4Link) {
    try {
      const result = await mp4FromConfig(`https://player.vimeo.com/video/${id}/config`, debug);
      if (result) ({ url: mp4Link, quality } = result);
    } catch {
      // fall through
    }
  }

  if (!mp4Link) {
    const suggestions = [];
    if (debug.embed_status === 401 || debug.player_status === 401) {
      suggestions.push('Video embedding may be restricted. In Vimeo settings, set "Where can this be embedded?" to "Anywhere".');
    }
    if (debug.config_status === 403) {
      suggestions.push("Vimeo blocked config access. This often happens with embedding restrictions.");
    }
    if (debug.api_status === 200 && debug.api_downloads === 0) {
      suggestions.push('Enable "Allow downloads" in Vimeo video settings to allow server-side access.');
    }
    if (!VIMEO_TOKEN) {
      suggestions.push("No VIMEO_ACCESS_TOKEN configured. Add it to the backend environment for API access.");
    }
    let errorMessage = "No MP4 file found.";
    if (suggestions.length > 0) errorMessage += " " + suggestions.join(" ");
    return res.status(422).json({
      error: errorMessage,
      debug,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
    });
  }

  const mp4Headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };
  if (req.headers.range) mp4Headers.Range = req.headers.range;
  const mp4Response = await fetch(mp4Link, { headers: mp4Headers });

  res.status(mp4Response.status);
  res.set({ "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=3600" });
  copyStreamHeaders(mp4Response, res);
  if (!mp4Response.body) return res.end();
  Readable.fromWeb(mp4Response.body).pipe(res);
  return undefined;
}

// ---------- chatterbox_proxy (GET and POST) ----------

async function streamChatterboxVideo({ req, res, taskId, serverIp }) {
  const ip = resolveIp(serverIp);
  if (!ip) return noServer(res);
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  const response = await fetch(`${chatterboxBase(ip)}/outputs/final_${encodeURIComponent(taskId)}.mp4`, { headers });
  if (!response.ok && response.status !== 206) {
    return res.status(response.status).json({ error: "Language avatar not found", status: response.status });
  }
  res.status(response.status);
  res.set({ "Content-Type": "video/mp4", "Cache-Control": "public, max-age=86400", "Accept-Ranges": "bytes" });
  copyStreamHeaders(response, res);
  if (!response.body) return res.end();
  Readable.fromWeb(response.body).pipe(res);
  return undefined;
}

async function serveChatterboxAvatar({ req, res, taskId, serverIp }) {
  if (!taskId) return badRequest(res, "task_id is required");
  let id = String(taskId);
  // The client sometimes sends the output name; the file on disk is final_<task>.mp4.
  if (id.startsWith("final_")) id = id.slice(6);
  if (!isSafeId(id)) return badRequest(res, "Invalid task_id");
  if (!isAllowedServerIp(serverIp)) return badRequest(res, "server_ip not allowed");
  return streamChatterboxVideo({ req, res, taskId: id, serverIp });
}

// ---------- chatterbox_generate / chatterbox_status / chatterbox_library (POST) ----------

async function chatterboxGenerate({ body, res, server_ip }) {
  const { text, language, speaker, avatar_id } = body;
  if (!text || !language || !speaker) {
    const missing = [];
    if (!text) missing.push("text");
    if (!language) missing.push("language");
    if (!speaker) missing.push("speaker");
    return res.status(400).json({
      error: `Missing required fields: ${missing.join(", ")}`,
      received: { text: !!text, language, speaker },
    });
  }
  const ip = resolveIp(server_ip);
  if (!ip) return noServer(res);

  const formData = new FormData();
  formData.append("text", text);
  formData.append("language", language);
  formData.append("speaker", speaker);
  if (avatar_id) formData.append("avatar_id", avatar_id);

  try {
    const response = await fetchWithRetry(`${chatterboxBase(ip)}/api/generate`, { method: "POST", body: formData }, 3);
    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: `Chatterbox generate failed: ${errorText}`, status: response.status });
    }
    const data = await response.json();
    return res.status(200).json({ success: true, task_id: data.task_id, ...data });
  } catch (e) {
    return res.status(503).json({ error: `Chatterbox server unavailable after 3 retries: ${e}`, retryable: true });
  }
}

async function chatterboxStatus({ body, res, server_ip }) {
  const { task_id } = body;
  if (!task_id) return badRequest(res, "task_id is required");
  const ip = resolveIp(server_ip);
  if (!ip) return noServer(res);

  try {
    const response = await fetchWithRetry(
      `${chatterboxBase(ip)}/api/status/${encodeURIComponent(task_id)}`,
      { method: "GET" },
      2,
    );
    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 404) {
        return res.status(200).json({
          status: "failed",
          error: "Task not found - generation may have failed",
          terminal: true,
        });
      }
      return res.status(response.status).json({ error: `Status check failed: ${errorText}`, status: response.status });
    }
    const data = await response.json();
    // "not_found" can also arrive inside a 200 body; treat it as terminal too.
    if (data.status === "not_found" || (typeof data.error === "string" && data.error.includes("not found"))) {
      return res.status(200).json({
        status: "failed",
        error: data.error || "Task not found - generation may have failed",
        terminal: true,
      });
    }
    return res.status(200).json(data);
  } catch (e) {
    return res.status(503).json({ error: `Chatterbox server unavailable: ${e}`, retryable: true, status: "error" });
  }
}

async function chatterboxLibrary({ res, server_ip }) {
  const ip = resolveIp(server_ip);
  if (!ip) return noServer(res);
  try {
    const response = await fetch(`${chatterboxBase(ip)}/api/library/list`);
    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: `Library fetch failed: ${errorText}`, status: response.status });
    }
    const data = await response.json();
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: `Chatterbox library error: ${e}` });
  }
}

// ---------- multilang (V2.5 API, port 5005) ----------

async function multilangGenerateAvatar({ body, res, server_ip }) {
  const { job_id: jobId, languages, speaker, target_sections, force_regenerate } = body;
  if (!jobId) return badRequest(res, "job_id is required");
  const ip = resolveIp(server_ip);
  if (!ip) return noServer(res);

  const payload = { languages: languages || ["hi"], speaker: speaker || "Sagar" };
  if (target_sections && target_sections.length > 0) payload.target_sections = target_sections;
  if (force_regenerate === true) payload.force_regenerate = true;

  try {
    // The GPU-side cloud FTP check can take 10-25s on cold starts, so allow 60s.
    const response = await fetch(`${v25Base(ip)}/job/${encodeURIComponent(jobId)}/generate_avatar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000),
    });
    const responseText = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({ error: `V2.5 API error: ${responseText}`, status: response.status });
    }
    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      data = { message: responseText };
    }
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: `Multi-language avatar generation error: ${e}` });
  }
}

async function multilangAvatarStatus({ body, res, server_ip }) {
  const jobId = body.job_id;
  if (!jobId) return badRequest(res, "job_id is required");
  const ip = resolveIp(server_ip);
  if (!ip) return noServer(res);

  const cloudIp = process.env.VIDEO_GEN_CLOUD_SERVER_IP || "";
  const isCloud = !!cloudIp && ip === cloudIp;
  const label = isCloud ? "Cloud" : "Normal";

  try {
    const response = await fetch(`${v25Base(ip)}/job/${encodeURIComponent(jobId)}/avatar_status`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    const responseText = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({
        error: `${label} avatar_status API error: ${responseText}`,
        status: response.status,
        state: response.status === 404 ? "not_found" : "unknown",
        // 404 is terminal only on the cloud server (the job is gone). Elsewhere it may be transient.
        terminal: isCloud && response.status === 404,
        server_path: isCloud ? "cloud" : "normal",
      });
    }
    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      data = { state: "unknown", message: responseText };
    }
    // Cloud Job schema: { state, source, progress, sections_done, sections_total, error }
    const state = String(data?.state ?? data?.status ?? "processing").toLowerCase();
    const sectionsTotal = Number(data?.sections_total ?? 0) || 0;
    const sectionsDone = Number(data?.sections_done ?? 0) || 0;
    const errorMsg = data?.error ?? null;
    return res.status(200).json({
      state,
      status: state, // legacy alias
      source: data?.source ?? null,
      total: sectionsTotal,
      completed: sectionsDone,
      progress: data?.progress ?? (sectionsTotal > 0 ? `${sectionsDone}/${sectionsTotal}` : null),
      message: errorMsg || "",
      error: errorMsg,
      raw: data,
    });
  } catch (e) {
    return res.status(500).json({ error: `Multi-language avatar status error: ${e}` });
  }
}

// ---------- save_language_avatar_to_cdn (POST) ----------

async function saveLanguageAvatarToCdn({ body, res, server_ip }) {
  const { task_id, external_job_id, section_id, language } = body;
  if (!task_id || !external_job_id || section_id === undefined || !language) {
    return badRequest(res, "task_id, external_job_id, section_id, and language are required");
  }
  // These values become path segments under VIDEO_OUTPUT_ROOT, so they are checked first.
  const jobSegment = String(external_job_id);
  const lang = String(language);
  if (!isSafeId(jobSegment) || !SAFE_LANGUAGE.test(lang) || !SAFE_SECTION_ID.test(String(section_id))) {
    return badRequest(res, "external_job_id, section_id, or language is invalid");
  }
  const ip = resolveIp(server_ip);
  if (!ip) return noServer(res);

  try {
    const downloadResponse = await fetch(`${chatterboxBase(ip)}/outputs/final_${encodeURIComponent(String(task_id))}.mp4`);
    if (!downloadResponse.ok) throw new Error(`Chatterbox responded with ${downloadResponse.status}`);
    const videoData = await downloadResponse.arrayBuffer();

    // English: /video/{job}/avatars/section_{n}_avatar.mp4; other: /video/{job}/avatars/{language}/...
    const outputRoot = process.env.VIDEO_OUTPUT_ROOT || "";
    if (!outputRoot) return res.status(500).json({ error: "VIDEO_OUTPUT_ROOT not configured" });
    const langLower = lang.toLowerCase();
    const dirPath = langLower !== "english"
      ? posix.join(outputRoot, jobSegment, "avatars", langLower)
      : posix.join(outputRoot, jobSegment, "avatars");
    const fullPath = posix.join(dirPath, `section_${section_id}_avatar.mp4`);

    await mkdir(dirPath, { recursive: true });
    await writeFile(fullPath, Buffer.from(videoData));

    return res.status(200).json({
      success: true,
      file_path: fullPath,
      size_bytes: videoData.byteLength,
      saved_at: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e instanceof Error ? e.message : "Unknown error" });
  }
}

// ---------- exports ----------

export const handlers = {
  chatterbox_proxy: (c) => serveChatterboxAvatar({ req: c.req, res: c.res, taskId: c.body?.task_id, serverIp: c.server_ip }),
  chatterbox_generate: chatterboxGenerate,
  chatterbox_status: chatterboxStatus,
  chatterbox_library: chatterboxLibrary,
  multilang_generate_avatar: multilangGenerateAvatar,
  multilang_avatar_status: multilangAvatarStatus,
  save_language_avatar_to_cdn: saveLanguageAvatarToCdn,
};

export const getHandlers = {
  vimeo_proxy: vimeoProxy,
  // The reference serves chatterbox_proxy from the GET block (unauthenticated, <video src> use).
  chatterbox_proxy: (c) => serveChatterboxAvatar({ req: c.req, res: c.res, taskId: c.query.task_id, serverIp: c.query.server_ip }),
};
