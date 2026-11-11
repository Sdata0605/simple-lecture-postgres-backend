// Port of supabase/functions/auto-submission-tick. Server-driven pipeline runner, run once a minute by the
// scheduler. For each running auto_submission_runs row it advances the current item one step
// (submit -> processing -> sanity -> next).
// Callers must send SERVICE_KEY as the Bearer token or in x-service-key (the original had no check of its own).
// Config (env): PUBLIC_BASE_URL (for the video proxy functions), SERVICE_KEY, AUTO_SUBMISSION_DEFAULT_AVATAR
// (optional fallback avatar id; defaults to the value the original used).
import crypto from "node:crypto";
import express from "express";
import { query } from "../_shared/db.js";

export const router = express.Router();

const MAX_JOBS_PER_IP = 2;
const PENDING_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const PROCESSING_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const SUBMITTING_LOCK_MS = 5 * 60 * 1000;
const DEFAULT_AVATAR = process.env.AUTO_SUBMISSION_DEFAULT_AVATAR || "avatar_5ab07dea";

function evaluateJobStatus(status) {
  if (status === "completed") return { proceed: true };
  return { proceed: false, reason: `Job ended as ${status ?? "unknown"}` };
}

function evaluateSanity(s) {
  if (!s) return { passed: false, reason: "No sanity summary returned" };
  if (s.avatar_healthy !== s.avatar_total) return { passed: false, reason: `Avatar ${s.avatar_healthy}/${s.avatar_total}` };
  if (s.topic_healthy !== s.topic_total) return { passed: false, reason: `Topic ${s.topic_healthy}/${s.topic_total}` };
  if (s.images_healthy !== s.images_total) return { passed: false, reason: `Images ${s.images_healthy}/${s.images_total}` };
  const denom = s.avatar_total + s.topic_total + s.images_total;
  const overall = denom > 0 ? Math.round(((s.avatar_healthy + s.topic_healthy + s.images_healthy) / denom) * 100) : 0;
  if (overall !== 100) return { passed: false, reason: `Overall ${overall}%` };
  return { passed: true };
}

async function countSlots(serverIp) {
  const now = Date.now();
  const pendingCutoff = new Date(now - PENDING_MAX_AGE_MS).toISOString();
  const processingCutoff = new Date(now - PROCESSING_MAX_AGE_MS).toISOString();
  const { rows } = await query(
    `SELECT
       (SELECT count(*)::int FROM public.video_generation_jobs WHERE server_ip = $1 AND status = 'pending' AND created_at > $2) +
       (SELECT count(*)::int FROM public.video_generation_jobs WHERE server_ip = $1 AND status = 'processing' AND created_at > $3) AS n`,
    [serverIp, pendingCutoff, processingCutoff]
  );
  return rows[0].n || 0;
}

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
async function genJobPrefix(subjectName) {
  const sanitized = String(subjectName || "").replace(/\s+/g, "");
  const d = new Date();
  const ts =
    d.getFullYear().toString() +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0") +
    String(d.getHours()).padStart(2, "0") +
    String(d.getMinutes()).padStart(2, "0") +
    String(d.getSeconds()).padStart(2, "0") +
    String(d.getMilliseconds()).padStart(3, "0");
  let code = "";
  for (let i = 0; i < 6; i++) code += CHARS.charAt(crypto.randomInt(CHARS.length));
  const full = `${sanitized}_${ts}_${code}`;
  await query("INSERT INTO public.video_job_prefixes (random_code, full_prefix, subject_name) VALUES ($1, $2, $3)", [code, full, sanitized]);
  return full;
}

const genDbId = () => String(crypto.randomInt(100000000, 1000000000));

// Calls one of the video proxy functions with the service key. Returns { ok, data }.
async function callProxy(body, fnName = "video-generation-proxy") {
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  const resp = await fetch(`${base}/functions/v1/${fnName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.SERVICE_KEY || ""}` },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => null);
  return { ok: resp.ok, data };
}

async function saveRun(runId, patch) {
  const cols = [];
  const params = [runId];
  for (const [k, v] of Object.entries(patch)) {
    if (!["items", "status", "current_index"].includes(k)) throw new Error("bad column");
    params.push(k === "items" ? JSON.stringify(v) : v);
    cols.push(`${k} = $${params.length}`);
  }
  cols.push("last_tick_at = now()");
  await query(`UPDATE public.auto_submission_runs SET ${cols.join(", ")} WHERE id = $1`, params);
}

async function processRun(run) {
  // Claim the run for this tick, so concurrent ticks cannot submit the same item twice.
  const { rows: claimRows } = await query("SELECT claim_auto_submission_run($1::uuid, 25) AS ok", [run.id]);
  if (claimRows[0]?.ok !== true) {
    console.log("[auto-submission-tick] skip", run.id, "another tick is active");
    return;
  }

  const items = Array.isArray(run.items) ? run.items : [];
  const idx = run.current_index ?? 0;
  if (idx >= items.length) {
    await saveRun(run.id, { status: "completed" });
    return;
  }
  const item = items[idx];
  const setItem = (patch) => {
    items[idx] = { ...items[idx], ...patch };
  };

  const cfg = run.pipeline_config && typeof run.pipeline_config === "object" ? run.pipeline_config : {};
  const isMarketing = run.kind === "marketing";
  const targetPort = Number(cfg.target_port) || (isMarketing ? 5006 : 5005);
  const proxyFn = isMarketing ? "marketing-video-proxy" : "video-generation-proxy";

  // QUEUED: submit if a slot is free
  if (item.status === "queued" || item.status === "waiting" || item.status === "submitting") {
    if (item.status === "submitting" && item.submittingAt) {
      const age = Date.now() - new Date(item.submittingAt).getTime();
      if (Number.isFinite(age) && age < SUBMITTING_LOCK_MS) {
        await saveRun(run.id, { items });
        return;
      }
    }

    const active = await countSlots(run.server_ip);
    if (active >= MAX_JOBS_PER_IP) {
      setItem({ status: "waiting" });
      await saveRun(run.id, { items });
      return;
    }
    setItem({ status: "submitting", submittingAt: new Date().toISOString() });
    await saveRun(run.id, { items });

    try {
      const jobPrefix = await genJobPrefix(run.subject_name);
      const payload = {
        action: "submit",
        server_ip: run.server_ip,
        target_port: targetPort,
        subject: run.subject_name,
        grade: cfg.grade ?? (isMarketing ? "9" : "12"),
        job_prefix: jobPrefix,
        dry_run: false,
        skip_wan: false,
        skip_avatar: false,
        audio_only: false,
        tts_provider: cfg.tts_provider ?? "our_tts",
        pipeline_version: cfg.pipeline_version ?? "v15_v2_director",
        generation_scope: "full",
        video_provider: cfg.video_provider ?? "kie",
        ocr_provider: cfg.ocr_provider ?? "local",
        skip_threejs: false,
        avatar_language: cfg.avatar_language ?? "english",
        llm_routing: {
          chunker: "openrouter",
          director: "openrouter",
          manim_renderer: "openrouter",
          hyperframes_renderer: "openrouter",
          remotion_renderer: "openrouter",
          video_renderer: "openrouter",
          prompt_enhancer: "openrouter",
          story_enhancer: "openrouter",
          ...(cfg.llm_routing && typeof cfg.llm_routing === "object" ? cfg.llm_routing : {}),
        },
      };
      if (cfg.no_quiz !== undefined) payload.no_quiz = cfg.no_quiz;
      if (cfg.image_provider) payload.image_provider = cfg.image_provider;
      if (cfg.image_model) payload.image_model = cfg.image_model;
      if (cfg.avatar_speaker) payload.avatar_speaker = cfg.avatar_speaker;
      if (cfg.tts_engine && cfg.tts_engine !== "default") payload.tts_engine = cfg.tts_engine;

      let effectiveAvatarId = "";
      if (typeof cfg.avatar_id === "string") {
        // An explicit avatar_id in the config (even "") is respected.
        effectiveAvatarId = cfg.avatar_id.trim();
      } else if (run.subject_id) {
        const { rows } = await query("SELECT avatar_id FROM public.popular_subjects WHERE id = $1 LIMIT 1", [run.subject_id]);
        if (rows[0]?.avatar_id) effectiveAvatarId = String(rows[0].avatar_id).trim();
      }
      // The global fallback applies only to non-marketing jobs with no avatar configured at all.
      if (!isMarketing && !effectiveAvatarId && cfg.avatar_id === undefined) effectiveAvatarId = DEFAULT_AVATAR;
      payload.avatar_id = effectiveAvatarId;
      if (cfg.model) payload.model = cfg.model;
      if (cfg.title) payload.title = cfg.title;
      if (Object.prototype.hasOwnProperty.call(cfg, "target_languages")) {
        const langs = cfg.target_languages;
        payload.target_languages = Array.isArray(langs) && langs.length > 0 ? langs : null;
      }
      if (cfg.reel_with_avatar !== undefined) payload.reel_with_avatar = cfg.reel_with_avatar;
      if (cfg.reel_variant) payload.reel_variant = cfg.reel_variant;
      if (cfg.story_hint) payload.story_hint = cfg.story_hint;
      if (cfg.audio_only !== undefined) payload.audio_only = cfg.audio_only;
      if (item.sourceUrl) {
        payload.document_url = item.sourceUrl;
        payload.file_name = item.fileName;
        payload.source_type = item.sourceType;
      } else if (item.markdown) {
        payload.markdown = item.markdown;
      } else {
        throw new Error("No source_url or markdown");
      }

      const { ok, data } = await callProxy(payload, proxyFn);
      if (!ok || !data?.job_id) throw new Error(data?.message || "submit failed");
      const extJobId = data.job_id;
      const dbJobId = genDbId();
      await query(
        `INSERT INTO public.video_generation_jobs
           (id, external_job_id, document_id, subject_id, document_name, status, created_by, server_ip, target_port)
         VALUES ($1, $2, $3, $4, $5, 'processing', $6, $7, $8)`,
        [dbJobId, extJobId, item.documentId, run.subject_id, item.displayName, run.created_by, run.server_ip, targetPort]
      );
      setItem({ status: "processing", externalJobId: extJobId, dbJobId, progress: 0, submittedAt: new Date().toISOString() });
      await saveRun(run.id, { items });
    } catch (e) {
      setItem({ status: "stopped", stopReason: `Submit failed: ${String(e?.message || e)}` });
      await saveRun(run.id, { items, status: "stopped" });
    }
    return;
  }

  // PROCESSING: poll status
  if (item.status === "processing" && item.externalJobId) {
    const { ok, data } = await callProxy(
      { action: "status", job_id: item.externalJobId, server_ip: run.server_ip, target_port: targetPort },
      proxyFn
    );
    if (!ok || !data) {
      await saveRun(run.id, { items });
      return;
    }
    setItem({
      progress: typeof data.progress === "number" ? data.progress : item.progress,
      currentStep: data.current_step ?? item.currentStep,
      currentPhase: data.current_phase ?? item.currentPhase,
    });
    const st = data.status;
    if (st === "completed" || st === "completed_with_errors" || st === "failed") {
      if (item.dbJobId) {
        await query(
          `UPDATE public.video_generation_jobs
              SET status = $2, progress = $3, video_url = $4, error_message = $5
            WHERE id = $1`,
          [
            item.dbJobId,
            st,
            st === "completed" ? 100 : data.progress ?? 0,
            `http://${run.server_ip}:${targetPort}/player_v2/?job=${item.externalJobId}`,
            data.error ?? null,
          ]
        );
      }
      const ev = evaluateJobStatus(st);
      if (!ev.proceed) {
        setItem({ status: "stopped", stopReason: ev.reason });
        await saveRun(run.id, { items, status: "stopped" });
        return;
      }
      // The marketing pipeline skips the sanity check.
      if (isMarketing) {
        setItem({ status: "passed", progress: 100, sanityDetail: "Completed" });
        const nextIdx = idx + 1;
        await saveRun(run.id, { items, current_index: nextIdx, status: nextIdx >= items.length ? "completed" : "running" });
        return;
      }
      setItem({ status: "sanity_checking", progress: 100 });
      await saveRun(run.id, { items });
      return;
    }
    await saveRun(run.id, { items });
    return;
  }

  // SANITY
  if (item.status === "sanity_checking" && item.externalJobId) {
    const { ok, data } = await callProxy({ action: "sanity_check", job_id: item.externalJobId, server_ip: run.server_ip });
    if (!ok) {
      await saveRun(run.id, { items }); // retried on the next tick
      return;
    }
    const result = evaluateSanity(data?.summary);
    if (!result.passed) {
      setItem({ status: "stopped", stopReason: `Sanity failed: ${result.reason}`, sanityDetail: result.reason });
      await saveRun(run.id, { items, status: "stopped" });
      return;
    }
    setItem({ status: "passed", sanityDetail: "All checks 100%" });
    const nextIdx = idx + 1;
    await saveRun(run.id, { items, current_index: nextIdx, status: nextIdx >= items.length ? "completed" : "running" });
    return;
  }

  // Passed or completed at the current index: advance.
  if (item.status === "passed" || item.status === "completed") {
    const nextIdx = idx + 1;
    await saveRun(run.id, { current_index: nextIdx, status: nextIdx >= items.length ? "completed" : "running" });
  }
}

router.post("/", async (req, res) => {
  const serviceKey = process.env.SERVICE_KEY;
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!serviceKey || (bearer !== serviceKey && req.headers["x-service-key"] !== serviceKey)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const { rows: runs } = await query("SELECT * FROM public.auto_submission_runs WHERE status = 'running'");
    await Promise.all(
      runs.map((r) =>
        processRun(r).catch((e) => {
          console.error("[auto-submission-tick] run", r.id, e?.message);
        })
      )
    );
    return res.json({ processed: runs.length });
  } catch (e) {
    console.error("[auto-submission-tick] error", e?.message);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});
