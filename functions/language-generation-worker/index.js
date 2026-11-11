// Port of supabase/functions/language-generation-worker. Cron orchestrator for bulk multi-language
// avatar generation. Each tick takes up to three 'processing' runs (skipping any touched in the
// last 50 seconds), submits or polls the current job of each run, and records progress.
// Auth: header x-service-key must equal SERVICE_KEY (the cron key). The render proxy is reached
// through PUBLIC_BASE_URL with that key as a Bearer token.
import express from "express";
import crypto from "node:crypto";
import { query } from "../_shared/db.js";

export const router = express.Router();

// Test hook: lets tests stub the render proxy so no real request is sent.
export const hooks = { fetch: (...args) => fetch(...args) };

const SOFT_LOCK_MS = 50 * 1000;
const STALL_TIMEOUT_MS = 30 * 60 * 1000;
const STALE_JOB_MS = 2 * 60 * 60 * 1000;

function serviceKeyOk(req) {
  const svc = process.env.SERVICE_KEY || "";
  const got = req.get("x-service-key") || "";
  return Boolean(svc) && got.length === svc.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(svc));
}

// Writes columns to one row. Arrays and plain objects are stored as JSON.
async function updateWhere(table, values, where) {
  const params = [];
  const sets = Object.entries(values).map(([k, v]) => {
    params.push(v !== null && typeof v === "object" ? JSON.stringify(v) : v);
    return `${k} = $${params.length}`;
  });
  const conds = Object.entries(where).map(([k, v]) => {
    params.push(v);
    return `${k} = $${params.length}`;
  });
  await query(`UPDATE public.${table} SET ${sets.join(", ")} WHERE ${conds.join(" AND ")}`, params);
}

async function updateRun(runId, updates) {
  try {
    await updateWhere("language_generation_runs", { ...updates, updated_at: new Date().toISOString() }, { id: runId });
  } catch (err) {
    console.error(`[LangWorker] Failed to update run ${runId}:`, err?.message);
  }
}

async function syncRun(run) {
  await updateRun(run.id, {
    status: run.status,
    job_queue: run.job_queue,
    current_job_index: run.current_job_index,
    completed_jobs: run.completed_jobs,
    failed_jobs: run.failed_jobs,
    skipped_jobs: run.skipped_jobs,
  });
}

function advanceToNext(run, jobs, currentIdx) {
  const nextIdx = currentIdx + 1;
  run.current_job_index = nextIdx;
  if (nextIdx >= jobs.length) {
    run.status = "completed";
    console.log(`[LangWorker] Run ${run.id} all jobs processed, marking completed`);
  }
}

async function callProxy(payload) {
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  const key = process.env.SERVICE_KEY || "";
  return hooks.fetch(`${base}/functions/v1/video-generation-proxy`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });
}

// Sections that have narration (text or segments). Empty when the review call fails.
async function fetchNarratedSections(externalJobId, serverIp) {
  try {
    const resp = await callProxy({ action: "review", job_id: externalJobId, server_ip: serverIp });
    if (!resp.ok) {
      console.error(`[LangWorker] fetchNarratedSections: review API error for ${externalJobId}: ${resp.status}`);
      return [];
    }
    const data = await resp.json();
    const sections = data?.sections || [];
    return sections.filter(
      (s) =>
        s.narration?.full_text ||
        (s.narration?.segments && s.narration.segments.length > 0) ||
        (s.explanation_plan?.visual_beats && s.explanation_plan.visual_beats.some((b) => b.segments && b.segments.length > 0)),
    );
  } catch (err) {
    console.error(`[LangWorker] fetchNarratedSections error for ${externalJobId}:`, err?.message);
    return [];
  }
}

async function checkIfAlreadyDone(job, languages) {
  const narratedSections = await fetchNarratedSections(job.external_job_id, job.server_ip);
  if (narratedSections.length === 0) return false;
  for (const lang of languages) {
    for (const section of narratedSections) {
      const avatar = (section.avatar_languages || []).find((a) => a.language === lang);
      if (!avatar || avatar.status !== "completed") return false;
    }
  }
  return true;
}

async function getLanguagesToGenerate(job, languages) {
  const narratedSections = await fetchNarratedSections(job.external_job_id, job.server_ip);
  if (narratedSections.length === 0) return languages;
  return languages.filter(
    (lang) =>
      !narratedSections.every((s) => (s.avatar_languages || []).find((a) => a.language === lang)?.status === "completed"),
  );
}

async function setTaskIds(job, taskBase, { onlyProcessing }) {
  for (const lang of job.languages) {
    const where = { video_job_id: job.video_job_id, language: lang };
    if (onlyProcessing) where.status = "processing";
    await updateWhere("language_avatar_jobs", { task_id: `v2_${taskBase}_${lang}`, status: "processing" }, where);
  }
}

async function submitLanguageGeneration(job, run) {
  try {
    for (const lang of job.languages) {
      try {
        await query(
          `INSERT INTO public.language_avatar_jobs
             (video_job_id, external_job_id, section_id, section_title, language, speaker, server_ip, status, progress)
           VALUES ($1, $2, 0, $3, $4, $5, $6, 'processing', 0)`,
          [job.video_job_id, job.external_job_id, `All Sections (${lang.toUpperCase()})`, lang, run.speaker, job.server_ip],
        );
      } catch (insertError) {
        console.error(`[LangWorker] Failed to create tracking record for ${lang}:`, insertError?.message);
      }
    }

    const payload = {
      action: "multilang_generate_avatar",
      job_id: job.external_job_id,
      languages: job.languages,
      speaker: run.speaker,
      server_ip: job.server_ip,
    };
    console.log("[LangWorker] Calling video-generation-proxy:", payload.action, job.external_job_id);

    const resp = await callProxy(payload);
    const data = await resp.json().catch(() => ({}));

    if (data?.error?.includes?.("already_running") || data?.message?.includes?.("already_running")) {
      console.log(`[LangWorker] Job ${job.external_job_id} already running, will track`);
      await setTaskIds(job, job.external_job_id, { onlyProcessing: true });
      return "already_running";
    }

    if (!resp.ok) {
      console.error(`[LangWorker] Proxy error: ${resp.status}`);
      return "failed";
    }

    const taskBase = data?.job_id || data?.task_id || job.external_job_id;
    await setTaskIds(job, taskBase, { onlyProcessing: true });
    return "success";
  } catch (err) {
    console.error("[LangWorker] Submit error:", err?.message);
    return "failed";
  }
}

// Reads progress for each language, writes it to language_avatar_jobs, and returns
// 'completed' | 'failed' | 'processing'. Also runs the stall and 2-hour stale checks.
async function pollLanguageStatus(job) {
  try {
    const narratedSections = await fetchNarratedSections(job.external_job_id, job.server_ip);
    if (narratedSections.length === 0) {
      console.log(`[LangWorker] No narrated sections found for ${job.external_job_id}, still processing`);
      return "processing";
    }

    let allCompleted = true;
    let totalCompleted = 0;
    const totalExpected = narratedSections.length * job.languages.length;

    for (const lang of job.languages) {
      let langCompleted = 0;
      let langFailed = 0;
      const langTotal = narratedSections.length;
      for (const section of narratedSections) {
        const avatar = (section.avatar_languages || []).find((a) => a.language === lang);
        if (avatar?.status === "completed") langCompleted++;
        else if (avatar?.status === "failed") langFailed++;
      }
      totalCompleted += langCompleted;
      const progress = langTotal > 0 ? Math.round((langCompleted / langTotal) * 100) : 0;
      const where = { video_job_id: job.video_job_id, language: lang };
      const now = new Date().toISOString();

      if (langCompleted === langTotal) {
        await updateWhere("language_avatar_jobs", { status: "completed", progress: 100, updated_at: now }, where);
      } else if (langFailed === langTotal) {
        await updateWhere(
          "language_avatar_jobs",
          { status: "failed", progress, error_message: "All sections failed", updated_at: now },
          where,
        );
      } else {
        allCompleted = false;
        await updateWhere("language_avatar_jobs", { status: "processing", progress, updated_at: now }, where);
      }
    }

    if (allCompleted) return "completed";

    if (job.last_progress_count !== null && job.last_progress_count === totalCompleted) {
      if (!job.stall_detected_at) {
        job.stall_detected_at = new Date().toISOString();
        console.log(`[LangWorker] Stall detected for ${job.video_job_id}: ${totalCompleted}/${totalExpected} sections completed`);
      } else {
        const stallStart = new Date(job.stall_detected_at).getTime();
        if (Date.now() - stallStart > STALL_TIMEOUT_MS) {
          console.log(`[LangWorker] Stall timeout for ${job.video_job_id}: stuck at ${totalCompleted}/${totalExpected}, forcing completion`);
          for (const lang of job.languages) {
            const langDone = narratedSections.every(
              (s) => (s.avatar_languages || []).find((a) => a.language === lang)?.status === "completed",
            );
            if (!langDone) {
              const langCompleted = narratedSections.filter(
                (s) => (s.avatar_languages || []).find((a) => a.language === lang)?.status === "completed",
              ).length;
              const progress = Math.round((langCompleted / narratedSections.length) * 100);
              await updateWhere(
                "language_avatar_jobs",
                {
                  status: "completed",
                  progress,
                  error_message: `Partial: ${langCompleted}/${narratedSections.length} sections completed (stall timeout)`,
                  updated_at: new Date().toISOString(),
                },
                { video_job_id: job.video_job_id, language: lang },
              );
            }
          }
          job.stall_detected_at = null;
          job.last_progress_count = null;
          return "completed";
        }
      }
    } else {
      job.stall_detected_at = null;
      job.last_progress_count = totalCompleted;
    }

    if (job.submitted_at) {
      const submittedAt = new Date(job.submitted_at).getTime();
      if (Date.now() - submittedAt > STALE_JOB_MS) {
        console.log(`[LangWorker] Job ${job.video_job_id} stale (>2h), marking failed`);
        job.error_message = "Stale: no completion after 2 hours";
        return "failed";
      }
    }
    return "processing";
  } catch (err) {
    console.error(`[LangWorker] Poll error for ${job.video_job_id}:`, err?.message);
    return "processing";
  }
}

async function processRun(run) {
  const jobs = run.job_queue;
  if (!jobs || jobs.length === 0) {
    console.log(`[LangWorker] Run ${run.id} has no jobs, marking completed`);
    await updateRun(run.id, { status: "completed", job_queue: jobs });
    return;
  }

  const { rows: freshRows } = await query("SELECT status FROM public.language_generation_runs WHERE id = $1", [run.id]);
  if (freshRows[0]?.status === "cancelled") {
    console.log(`[LangWorker] Run ${run.id} was cancelled, stopping`);
    return;
  }

  const idx = run.current_job_index;
  if (idx >= jobs.length) {
    console.log(`[LangWorker] Run ${run.id} all jobs done, marking completed`);
    await updateRun(run.id, { status: "completed" });
    return;
  }

  const job = jobs[idx];
  console.log(`[LangWorker] Run ${run.id} | job ${idx + 1}/${jobs.length} | jobId=${job.video_job_id} | status=${job.status}`);

  if (job.status === "pending") {
    if (await checkIfAlreadyDone(job, run.languages)) {
      console.log(`[LangWorker] Job ${job.video_job_id} already has all languages done, skipping`);
      job.status = "skipped";
      job.completed_at = new Date().toISOString();
      run.skipped_jobs++;
      advanceToNext(run, jobs, idx);
      await syncRun(run);
      return;
    }

    const langsToGenerate = await getLanguagesToGenerate(job, run.languages);
    if (langsToGenerate.length === 0) {
      console.log(`[LangWorker] Job ${job.video_job_id} no new languages needed, skipping`);
      job.status = "skipped";
      job.completed_at = new Date().toISOString();
      run.skipped_jobs++;
      advanceToNext(run, jobs, idx);
      await syncRun(run);
      return;
    }

    job.languages = langsToGenerate;
    const submitResult = await submitLanguageGeneration(job, run);

    if (submitResult === "success" || submitResult === "already_running") {
      job.status = "processing";
      job.submitted_at = new Date().toISOString();
    } else {
      job.status = "failed";
      job.error_message = "Failed to submit generation request";
      job.completed_at = new Date().toISOString();
      run.failed_jobs++;
      advanceToNext(run, jobs, idx);
    }
    await syncRun(run);
  } else if (job.status === "submitted" || job.status === "processing") {
    const pollResult = await pollLanguageStatus(job);
    if (pollResult === "completed") {
      console.log(`[LangWorker] Job ${job.video_job_id} completed successfully`);
      job.status = "completed";
      job.completed_at = new Date().toISOString();
      run.completed_jobs++;
      advanceToNext(run, jobs, idx);
    } else if (pollResult === "failed") {
      console.log(`[LangWorker] Job ${job.video_job_id} failed`);
      job.status = "failed";
      job.completed_at = new Date().toISOString();
      run.failed_jobs++;
      advanceToNext(run, jobs, idx);
    }
    await syncRun(run);
  }
}

router.post("/", async (req, res) => {
  if (!serviceKeyOk(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { rows: runs } = await query(
      "SELECT * FROM public.language_generation_runs WHERE status = 'processing' ORDER BY created_at ASC LIMIT 3",
    );
    if (runs.length === 0) return res.json({ message: "No active runs" });

    console.log(`[LangWorker] Found ${runs.length} active run(s)`);
    for (const run of runs) {
      const updatedAt = new Date(run.updated_at).getTime();
      const now = Date.now();
      if (now - updatedAt < SOFT_LOCK_MS) {
        console.log(`[LangWorker] Run ${run.id} soft-locked, skipping`);
        continue;
      }
      // Touch updated_at to claim this run.
      await updateWhere("language_generation_runs", { updated_at: new Date().toISOString() }, { id: run.id });
      await processRun(run);
    }
    res.json({ success: true });
  } catch (err) {
    console.error("[LangWorker] Unhandled error:", err?.message);
    res.status(500).json({ error: String(err?.message || err) });
  }
});
