// Ported video-generation-proxy actions: review, section review submission, regeneration, sanity check,
// repair/stitch, and status/analytics reads (see ../helpers.js for the handler contract).
// None of these actions touches Postgres or B2; they only call the GPU server (c.dynamicBase / c.submitBase).
import { badRequest, defaultServerIp } from "../helpers.js";

const CDN_BASE = "https://server1.simplelecture.com/video";
const JSON_POST = (payload) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

// Reads an upstream reply once. JSON is returned as-is; anything else is wrapped as { raw }.
async function readJsonOrRaw(response) {
  const raw = await response.text().catch(() => "");
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

const is2xx = (status) => status >= 200 && status < 300;

// Maps a beat video reference to the path served by the GPU server.
function resolveBeatPath(p) {
  let resolved = p;
  if (!/\.\w{2,5}$/.test(resolved)) resolved += ".mp4";
  if (!resolved.includes("/")) resolved = `videos/${resolved}`;
  return resolved;
}

// Flags Docker path leaks and malformed double slashes in visual beat image ids.
function checkUrlHealth(section) {
  const issues = [];
  const visualBeats = section.visual_beats || section.explanation_plan?.visual_beats || [];
  for (const beat of visualBeats) {
    const imageId = beat.image_id;
    if (imageId) {
      if (imageId.includes("/app/player/")) issues.push("Docker path leak: /app/player/");
      if (imageId.includes("//") && !imageId.startsWith("http")) issues.push("Malformed URL: double slashes");
    }
  }
  return { clean: issues.length === 0, issues };
}

// Per-section V2.5 logic check. Returns N/A for intro and for unknown section types.
function checkV25Logic(section) {
  const sectionType = section.section_type;
  const renderer = section.renderer;
  if (sectionType === "intro") return { status: "N/A", type: null, details: null };

  const segments = section.narration?.segments?.length || 0;
  const visualBeats = section.visual_beats || section.explanation_plan?.visual_beats || [];

  if (sectionType === "recap") {
    return { status: segments >= 5 ? "PASS" : "FAIL", type: "Cinematic 5", details: { segs: segments } };
  }
  if (sectionType === "quiz") {
    const steps = section.quiz_flow?.steps?.length || 0;
    const pass = steps >= 3 && segments >= 6;
    return { status: pass ? "PASS" : "FAIL", type: "Quiz Flow", details: { steps, segs: segments } };
  }
  if (sectionType === "summary") {
    const bullets = section.bullet_points?.length || visualBeats.length || 0;
    return { status: segments >= bullets ? "PASS" : "FAIL", type: "Deep Sync", details: { bullets, segs: segments } };
  }
  if (sectionType === "memory") {
    const flashcards = section.flashcards?.length || 0;
    const pass = flashcards >= 5 && segments >= 6;
    return { status: pass ? "PASS" : "FAIL", type: "Memory Check", details: { flashcards, segs: segments } };
  }
  if (renderer === "MANIM") {
    const specs = section.manim_specs?.length || 0;
    const linkedBeats = visualBeats.filter((b) => b.image_id).length;
    return {
      status: specs > 0 ? "PASS" : "FAIL",
      type: "Manim V2.6",
      details: { specs, disk: linkedBeats, linked: linkedBeats },
    };
  }
  if (sectionType === "content") {
    const bullets = visualBeats.length;
    return { status: segments >= 1 ? "PASS" : "FAIL", type: "Deep Sync", details: { bullets, segs: segments } };
  }
  return { status: "N/A", type: null, details: null };
}

// Builds the health report for one section. checkFile(path) resolves to an HTTP status (0 on error).
async function sectionHealthFor(section, checkFile) {
  const sectionId = section.section_id;

  const avatarPath = section.avatar_video || `avatars/section_${sectionId}_avatar.mp4`;
  const avatarStatus = await checkFile(avatarPath);

  // beat_videos live at section level or inside narration segments.
  const allBeatVideos = section.beat_videos ? [...section.beat_videos] : [];
  if (allBeatVideos.length === 0 && section.narration?.segments) {
    for (const seg of section.narration.segments) {
      if (seg.beat_videos) allBeatVideos.push(...seg.beat_videos);
    }
  }

  let topicPath = "";
  let topicStatus = null;
  let orphanTopicVideo = null;
  if (section.video_path) {
    topicPath = section.video_path;
    topicStatus = await checkFile(topicPath);
  } else if (allBeatVideos.length > 0) {
    topicPath = resolveBeatPath(allBeatVideos[0]);
    topicStatus = await checkFile(topicPath);
  }
  // Orphan check: a file that exists on disk but is not referenced in the JSON.
  if (!topicPath && (section.renderer === "MANIM" || section.section_type === "content" || section.section_type === "recap")) {
    const expectedPattern = `videos/topic_${sectionId}_beat_0.mp4`;
    const orphanStatus = await checkFile(expectedPattern);
    if (is2xx(orphanStatus)) orphanTopicVideo = { path: expectedPattern, status: orphanStatus };
  }

  const visualBeats = section.visual_beats || section.explanation_plan?.visual_beats || [];
  const imageIds = visualBeats.filter((beat) => beat.image_id).map((beat) => beat.image_id);
  const images = await Promise.all(
    imageIds.map(async (imageId) => {
      // The server stores images as PNG, so .jpg/.jpeg references are checked as .png.
      const normalizedId = imageId.replace(/\.jpe?g$/i, ".png");
      const imagePath = normalizedId.includes("/") ? normalizedId : `images/${normalizedId}`;
      const status = await checkFile(imagePath);
      return { image_id: imageId, beat_id: visualBeats.find((b) => b.image_id === imageId)?.beat_id || "", status };
    }),
  );

  // Prompts vs disk: count the beat videos that actually exist.
  const promptCount = (section.video_prompts || []).length;
  const resolvedPaths = allBeatVideos.map(resolveBeatPath);
  const beatStatuses = await Promise.all(resolvedPaths.map((p) => checkFile(p)));
  let diskCount = 0;
  if (allBeatVideos.length > 0) {
    diskCount = beatStatuses.filter(is2xx).length;
  } else if (topicStatus !== null && is2xx(topicStatus)) {
    diskCount = 1;
  }

  let promptsVsDisk;
  if (promptCount === 0) {
    promptsVsDisk = { status: "N/A" };
  } else {
    promptsVsDisk = {
      status: diskCount >= promptCount ? "MATCH" : "MISMATCH",
      prompts: promptCount,
      disk: diskCount,
      files: resolvedPaths.map((p, i) => ({ path: p, status: beatStatuses[i] })),
    };
  }

  return {
    section_id: sectionId,
    section_type: section.section_type,
    title: section.title,
    renderer: section.renderer || null,
    avatar_video: { path: avatarPath, status: avatarStatus },
    topic_video: { path: topicPath || null, status: topicStatus, orphan: orphanTopicVideo },
    prompts_vs_disk: promptsVsDisk,
    images,
    url_health: checkUrlHealth(section),
    v25_logic_check: checkV25Logic(section),
  };
}

async function sanityCheck(c) {
  const { res, job_id, dynamicBase } = c;
  const checkFile = async (path) => {
    try {
      const response = await fetch(`${dynamicBase}/player/jobs/${job_id}/${path}`, { method: "HEAD" });
      return response.status;
    } catch {
      return 0;
    }
  };

  const presentationResponse = await fetch(`${dynamicBase}/player/jobs/${job_id}/presentation.json`);
  if (!presentationResponse.ok) {
    return res.status(presentationResponse.status).json({ error: "Failed to fetch presentation data" });
  }
  const presentation = await presentationResponse.json();
  const sections = presentation.sections || [];
  const presentationTitle = presentation.presentation_title || "Unknown";

  const sectionHealth = await Promise.all(sections.map((s) => sectionHealthFor(s, checkFile)));

  let avatarHealthy = 0, avatarTotal = 0;
  let topicHealthy = 0, topicTotal = 0;
  let imagesHealthy = 0, imagesTotal = 0;
  let urlIssuesCount = 0;
  let v25PassCount = 0, v25FailCount = 0;
  const orphanFiles = [];

  for (const section of sectionHealth) {
    avatarTotal++;
    if (is2xx(section.avatar_video.status)) avatarHealthy++;

    // Only topic videos referenced by the JSON count; orphan guesses do not.
    if (section.topic_video.path) {
      topicTotal++;
      if (section.topic_video.status !== null && is2xx(section.topic_video.status)) topicHealthy++;
    }
    if (section.topic_video.orphan) orphanFiles.push(section.topic_video.orphan.path);

    for (const img of section.images) {
      imagesTotal++;
      if (is2xx(img.status)) imagesHealthy++;
    }

    if (!section.url_health.clean) urlIssuesCount++;

    if (section.v25_logic_check.status === "PASS") v25PassCount++;
    if (section.v25_logic_check.status === "FAIL") v25FailCount++;
  }

  return res.status(200).json({
    job_id,
    presentation_title: presentationTitle,
    check_status: "complete",
    orphans_found: orphanFiles.length > 0,
    orphan_files: orphanFiles,
    sections: sectionHealth,
    summary: {
      total_sections: sections.length,
      avatar_healthy: avatarHealthy,
      avatar_total: avatarTotal,
      topic_healthy: topicHealthy,
      topic_total: topicTotal,
      images_healthy: imagesHealthy,
      images_total: imagesTotal,
      url_issues: urlIssuesCount,
      v25_pass: v25PassCount,
      v25_fail: v25FailCount,
    },
  });
}

export const handlers = {
  // Public (no Authorization). Falls back to the CDN copy of presentation.json when the GPU server lacks it.
  review: async (c) => {
    const { res, job_id, dynamicBase } = c;
    if (!job_id) return badRequest(res, "job_id is required");

    let response;
    try {
      response = await fetch(`${dynamicBase}/player/jobs/${job_id}/presentation.json`);
    } catch (fetchErr) {
      console.error(`Connection error fetching presentation.json for job ${job_id}:`, fetchErr);
      return res.status(200).json({
        error: `Server unreachable at ${c.server_ip || defaultServerIp()}:5005. The video generation server may be down or restarting.`,
      });
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Upstream error for job ${job_id}: ${response.status} - ${errorText}`);
      try {
        const cdnResp = await fetch(`${CDN_BASE}/${job_id}/presentation.json`);
        if (cdnResp.ok) {
          const cdnData = await cdnResp.json();
          console.log(`[review] Served ${job_id} from CDN fallback`);
          return res.status(200).json(cdnData);
        }
      } catch (cdnErr) {
        console.error(`[review] CDN fallback failed for ${job_id}:`, cdnErr);
      }
      return res.status(response.status).json({ error: `Upstream error: ${errorText}`, status: response.status });
    }

    const data = await response.json();
    return res.status(200).json(data);
  },

  // Forwards section-level review notes as upstream "edits". Falls back to the global route on 404.
  submit_review: async (c) => {
    const { res, job_id, dynamicBase } = c;
    if (!job_id) return badRequest(res, "job_id is required");

    const { sections } = c.body;
    if (!sections || !Array.isArray(sections)) return badRequest(res, "sections array is required");

    // The upstream has historically varied its field names, so several common keys are sent.
    const edits = sections
      .filter((s) => typeof s?.section_id === "number" && typeof s?.notes === "string" && !!s.notes.trim())
      .map((s) => ({
        section_id: s.section_id,
        notes: s.notes,
        feedback: s.notes,
        edit: s.notes,
        text: s.notes,
      }));
    if (!edits.length) return badRequest(res, "No edits to submit");

    const requestBody = { job_id, edits };
    console.log(`[SUBMIT_REVIEW] Upstream payload for ${job_id}:`, JSON.stringify(requestBody));

    let response = await fetch(`${dynamicBase}/job/${job_id}/submit_review`, JSON_POST(requestBody));
    if (!response.ok) {
      const peek = await response.clone().text().catch(() => "");
      if (response.status === 404 || peek.includes("No edits provided")) {
        console.log(`[SUBMIT_REVIEW] Primary rejected (${response.status}). Retrying via /submit_review`);
        response = await fetch(`${dynamicBase}/submit_review`, JSON_POST(requestBody));
      }
    }

    const data = await readJsonOrRaw(response);
    console.log(`[SUBMIT_REVIEW] Response status: ${response.status}, body:`, JSON.stringify(data));
    return res.status(response.status).json(data);
  },

  // Re-runs one section through the retry_phase endpoint with inline feedback.
  regenerate_with_feedback: async (c) => {
    const { res, job_id, dynamicBase } = c;
    if (!job_id) return badRequest(res, "job_id is required");

    const { section_id, feedback, phase = "avatar_generation" } = c.body;
    if (section_id === undefined || section_id === null) return badRequest(res, "section_id is required");

    try {
      const response = await fetch(
        `${dynamicBase}/job/${job_id}/retry_phase`,
        JSON_POST({ phase, section_ids: [section_id], user_feedback: feedback || "" }),
      );
      const data = await readJsonOrRaw(response);
      console.log(`[REGEN_FEEDBACK] Response status: ${response.status}, body:`, JSON.stringify(data));
      return res.status(response.status).json({ success: response.ok, section_id, phase, ...data });
    } catch (e) {
      console.error("[REGEN_FEEDBACK] Error:", e);
      return res.status(500).json({ error: `Regenerate with feedback error: ${e}` });
    }
  },

  // Asks the GPU server to rebuild the job (all sections, or the given section_ids), optionally with edits.
  recreate_from_review: async (c) => {
    const { res, job_id, dynamicBase } = c;
    if (!job_id) return badRequest(res, "job_id is required");

    const { section_ids, edits } = c.body;
    const requestBody = { job_id };
    if (section_ids && Array.isArray(section_ids)) requestBody.section_ids = section_ids;
    if (edits && Array.isArray(edits)) requestBody.edits = edits;

    const response = await fetch(`${dynamicBase}/recreate_job_from_review`, JSON_POST(requestBody));
    const data = await readJsonOrRaw(response);
    return res.status(response.status).json(data);
  },

  sanity_check: async (c) => {
    if (!c.job_id) return badRequest(c.res, "job_id is required");
    return sanityCheck(c);
  },

  repair_urls: async (c) => {
    const { res, job_id, dynamicBase } = c;
    if (!job_id) return badRequest(res, "job_id is required");

    const response = await fetch(`${dynamicBase}/api/repair-urls/${job_id}`, { method: "POST" });
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`URL repair failed for job ${job_id}: ${response.status} - ${errorText}`);
      return res.status(response.status).json({ error: `URL repair failed: ${errorText}`, status: response.status });
    }
    const data = await response.json();
    return res.status(200).json({ success: true, ...data });
  },

  // Upstream failures are reported with HTTP 200 and status "error", as in the original.
  repair_missing_assets: async (c) => {
    const { res, job_id, dynamicBase } = c;
    if (!job_id) return badRequest(res, "job_id is required");

    const response = await fetch(`${dynamicBase}/api/repair-missing-assets/${job_id}`, { method: "POST" });
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Repair missing assets failed for job ${job_id}: ${response.status} - ${errorText}`);
      let errorMessage = errorText;
      try {
        const parsed = JSON.parse(errorText);
        errorMessage = parsed.error || parsed.message || errorText;
      } catch {
        // keep the raw text
      }
      return res.status(200).json({ status: "error", error: errorMessage, upstream_status: response.status });
    }
    const data = await response.json();
    return res.status(200).json(data);
  },

  stitch_assets: async (c) => {
    const { res, job_id, dynamicBase } = c;
    if (!job_id) return badRequest(res, "job_id is required");

    const response = await fetch(`${dynamicBase}/api/repair-metadata/${job_id}`, { method: "POST" });
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Asset stitch failed for job ${job_id}: ${response.status} - ${errorText}`);
      return res.status(response.status).json({ error: `Asset stitch failed: ${errorText}`, status: response.status });
    }
    const data = await response.json();
    return res.status(200).json(data);
  },

  // 404 from the GPU server means no avatar regeneration is running, reported as state "idle".
  avatar_regen_status: async (c) => {
    const { res, job_id, dynamicBase } = c;
    if (!job_id) return badRequest(res, "job_id is required");

    try {
      const response = await fetch(`${dynamicBase}/job/${job_id}/avatar_status`);
      if (response.status === 404) {
        return res.status(200).json({ state: "idle", message: "No active avatar regeneration task", details: null });
      }
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[REGEN STATUS] Avatar status fetch failed: ${response.status} - ${errorText}`);
        return res.status(response.status).json({
          state: "error",
          message: `Failed to fetch status: ${errorText}`,
          error: errorText,
        });
      }
      const data = await response.json();
      return res.status(200).json(data);
    } catch (e) {
      console.error("[REGEN STATUS] Avatar status error:", e);
      return res.status(500).json({ state: "error", message: `Status fetch error: ${e}` });
    }
  },

  regen_job_status: async (c) => {
    const { res, job_id, dynamicBase } = c;
    if (!job_id) return badRequest(res, "job_id is required");

    try {
      const response = await fetch(`${dynamicBase}/job/${job_id}/status`);
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[REGEN STATUS] Job status fetch failed: ${response.status} - ${errorText}`);
        return res.status(response.status).json({ status: "error", status_message: `Failed to fetch status: ${errorText}` });
      }
      const data = await response.json();
      return res.status(200).json(data);
    } catch (e) {
      console.error("[REGEN STATUS] Job status error:", e);
      return res.status(500).json({ status: "error", status_message: `Status fetch error: ${e}` });
    }
  },

  analytics: async (c) => {
    const { res, job_id, dynamicBase } = c;
    if (!job_id) return badRequest(res, "job_id is required");

    try {
      const response = await fetch(`${dynamicBase}/jobs/${job_id}/analytics.json`);
      if (!response.ok) {
        console.log(`[ANALYTICS] analytics.json not found or failed: ${response.status}`);
        return res.status(response.status).json({ error: "Analytics not available", status: response.status });
      }
      const data = await response.json();
      return res.status(200).json(data);
    } catch (e) {
      console.error("[ANALYTICS] Error:", e);
      return res.status(500).json({ error: `Analytics fetch error: ${e}` });
    }
  },

  avatar_bulk_status: async (c) => {
    const { res, job_id, dynamicBase } = c;
    if (!job_id) return badRequest(res, "job_id is required");

    try {
      const response = await fetch(`${dynamicBase}/jobs/${job_id}/avatar_status.json`);
      if (!response.ok) {
        console.log(`[AVATAR_BULK_STATUS] avatar_status.json not found: ${response.status}`);
        return res.status(response.status).json({ error: "Avatar status not available", status: response.status });
      }
      const data = await response.json();
      return res.status(200).json(data);
    } catch (e) {
      console.error("[AVATAR_BULK_STATUS] Error:", e);
      return res.status(500).json({ error: `Avatar bulk status fetch error: ${e}` });
    }
  },
};

export const getHandlers = {};
