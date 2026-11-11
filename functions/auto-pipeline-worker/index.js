// Port of supabase/functions/auto-pipeline-worker. Server-side orchestrator for the video generation pipeline.
// Runs one active run per call (scheduled every minute, and on demand after approval). Each call advances
// the run's job_queue: submit (with IP failover), poll, sanity check, retry missing phases, and report.
// Callers: SERVICE_KEY (Bearer or x-service-key), or an admin JWT. The original had no check of its own.
// Config (env): PUBLIC_BASE_URL (for video-generation-proxy), SERVICE_KEY. Generation servers are addressed by the
// server_ip stored with each run (ports 5005 for the player and 5006 for status, as before).
import crypto from "node:crypto";
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";

export const router = express.Router();

const MAX_RETRIES = 3;
const MAX_JOBS_PER_IP = 2;
const STALE_PROCESSING_HOURS = 2;
const REPAIR_POLL_INTERVAL_MS = 3 * 60 * 1000;
const REPAIR_RETRY_THRESHOLD_MS = 30 * 60 * 1000;
const DONE = ["done_good", "done_bad", "skipped"];

const proxyBase = () => (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

// Calls video-generation-proxy with the service key. Returns the parsed JSON body, or null on any failure.
async function proxyCall(body) {
  try {
    const resp = await fetch(`${proxyBase()}/functions/v1/video-generation-proxy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.SERVICE_KEY || ""}` },
      body: JSON.stringify(body),
    });
    return await resp.json();
  } catch {
    return null;
  }
}

// Rebuilds the job_queue from chapters_data when the queue was lost.
function tryRecoverQueueFromChaptersData(chaptersData) {
  if (!Array.isArray(chaptersData)) return null;
  const statusMap = {
    already_done: "skipped",
    done_good: "done_good",
    done_bad: "done_bad",
    processing: "queued",
    submitting: "queued",
    sanity_checking: "queued",
    retrying: "queued",
    needs_repair: "queued",
    queued: "queued",
  };
  const recovered = [];
  for (const chapter of chaptersData) {
    if (!Array.isArray(chapter.jobs)) continue;
    for (const job of chapter.jobs) {
      recovered.push({
        topicId: job.topicId,
        topicName: job.topicName,
        topicNumber: job.topicNumber,
        chapterId: job.chapterId,
        chapterName: job.chapterName,
        chapterNumber: job.chapterNumber,
        documentId: job.documentId,
        documentName: job.documentName,
        sourceUrl: job.sourceUrl,
        sourceType: job.sourceType,
        fileName: job.fileName,
        category: job.category || "needs_new_job",
        status: statusMap[job.status] || "queued",
        externalJobId: job.externalJobId,
        serverIp: job.serverIp,
        retryCount: job.retryCount || 0,
        retryDetails: job.retryDetails || [],
        errorMessage: job.errorMessage,
        failedPhases: job.failedPhases || [],
        submittedAt: job.submittedAt,
        completedAt: job.completedAt,
        lastPolledAt: null,
        repairStartedAt: null,
      });
    }
  }
  return recovered.length > 0 ? recovered : null;
}

const generateJobPrefix = (subjectName) => {
  const sanitized = String(subjectName).replace(/\s+/g, "");
  const now = new Date();
  const ts =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0") +
    String(now.getHours()).padStart(2, "0") +
    String(now.getMinutes()).padStart(2, "0") +
    String(now.getSeconds()).padStart(2, "0") +
    String(now.getMilliseconds()).padStart(3, "0");
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars.charAt(crypto.randomInt(chars.length));
  return `${sanitized}_${ts}_${code}`;
};

// Verifies one stale job with its generation server before changing the row.
async function reconcileStaleJob(serverIp, row) {
  if (!row.external_job_id) return;
  try {
    const resp = await fetch(`http://${serverIp}:5006/job/${row.external_job_id}/status`);
    if (!resp.ok) return;
    const data = await resp.json();
    if (data?.status === "completed") {
      await query(
        `UPDATE public.video_generation_jobs
            SET status = 'completed', progress = 100, video_url = $2, completed_at = $3, error_message = NULL
          WHERE id = $1`,
        [
          row.id,
          data.player_url || data.video_url || `http://${serverIp}:5005/player_v2/?job=${row.external_job_id}`,
          new Date().toISOString(),
        ]
      );
    } else if (data?.status === "failed") {
      await query("UPDATE public.video_generation_jobs SET status = 'failed', error_message = $2 WHERE id = $1", [
        row.id,
        data?.error || "Job failed on server",
      ]);
    }
  } catch {
    // Network error: leave the row, retry next cycle.
  }
}

async function countActiveJobsOnIp(serverIp) {
  const cutoff3h = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const { rows: stale } = await query(
    `SELECT id, external_job_id FROM public.video_generation_jobs
      WHERE server_ip = $1 AND status IN ('pending', 'processing') AND created_at < $2`,
    [serverIp, cutoff3h]
  );
  if (stale.length > 0) await Promise.all(stale.map((r) => reconcileStaleJob(serverIp, r)));

  const { rows } = await query(
    `SELECT count(*)::int AS n FROM public.video_generation_jobs
      WHERE server_ip = $1 AND status IN ('pending', 'processing') AND created_at > $2`,
    [serverIp, cutoff3h]
  );
  return rows[0].n || 0;
}

// Submits a new job through the proxy. Returns { externalJobId, dbJobId }, 'dedup_skip', or null.
async function submitJob(job, serverIp, subjectName, subjectId, createdBy) {
  try {
    if (job.documentId) {
      const { rows: docRows } = await query("SELECT topic_id FROM public.ai_assistant_documents WHERE id = $1", [job.documentId]);
      const topicId = docRows[0]?.topic_id;
      if (topicId) {
        const { rows: allDocs } = await query(
          "SELECT id FROM public.ai_assistant_documents WHERE topic_id = $1 AND source_url IS NOT NULL",
          [topicId]
        );
        if (allDocs.length > 0) {
          const { rows: existing } = await query(
            `SELECT id, status FROM public.video_generation_jobs
              WHERE document_id = ANY($1::uuid[]) AND status IN ('completed', 'completed_with_errors', 'processing', 'pending')
              LIMIT 1`,
            [allDocs.map((d) => d.id)]
          );
          if (existing.length > 0) {
            console.log(`[Worker] DEDUP_SKIP | topic="${job.topicName}" | existingJob=${existing[0].id} | status=${existing[0].status}`);
            return "dedup_skip";
          }
        }
      }
    }

    const jobPrefix = generateJobPrefix(subjectName);
    const payload = {
      action: "submit",
      subject: subjectName,
      job_prefix: jobPrefix,
      tts_provider: "our_tts",
      pipeline_version: "v15_v2_director",
      target_port: 5005,
      server_ip: serverIp,
    };
    if (job.sourceUrl) {
      payload.document_url = job.sourceUrl;
      payload.file_name = job.fileName;
      payload.source_type = job.sourceType;
    }

    console.log(`[Worker] SUBMIT | topic="${job.topicName}" | ip=${serverIp} | docId=${job.documentId}`);
    const data = await proxyCall(payload);
    if (!data?.job_id) {
      console.error(`[Worker] SUBMIT_FAIL | topic="${job.topicName}" | error=${data?.message || "No job ID"}`);
      return null;
    }

    const uniqueId = String(crypto.randomInt(100000000, 1000000000));
    await query(
      `INSERT INTO public.video_generation_jobs
         (id, external_job_id, document_id, subject_id, document_name, status, created_by, server_ip)
       VALUES ($1, $2, $3, $4, $5, 'processing', $6, $7)`,
      [uniqueId, data.job_id, job.documentId, subjectId, job.documentName, createdBy, serverIp]
    );
    console.log(`[Worker] SUBMIT_OK | topic="${job.topicName}" | extJobId=${data.job_id} | dbJobId=${uniqueId}`);
    return { externalJobId: data.job_id, dbJobId: uniqueId };
  } catch (err) {
    console.error(`[Worker] SUBMIT_ERROR | topic="${job.topicName}" | error=${err?.message}`);
    return null;
  }
}

async function pollJobStatus(externalJobId, serverIp) {
  try {
    const resp = await fetch(`http://${serverIp}:5005/job/${externalJobId}/status`);
    if (!resp.ok) return "processing";
    const data = await resp.json();
    return data.status || "processing";
  } catch {
    return "processing";
  }
}

const runSanityCheck = async (externalJobId, serverIp) => {
  const data = await proxyCall({ action: "sanity_check", job_id: externalJobId, server_ip: serverIp });
  return data && !data.error ? data : null;
};

function getMissingPhases(sanity) {
  const missing = [];
  if (!sanity?.summary) return missing;
  if (sanity.summary.avatar_healthy < sanity.summary.avatar_total) missing.push("avatar_generation");
  if (sanity.summary.topic_healthy < sanity.summary.topic_total) {
    const hasManim = sanity.sections?.some((s) => s.renderer === "manim" && s.topic_video?.status !== 200);
    const hasWan = sanity.sections?.some((s) => s.renderer !== "manim" && s.topic_video?.status !== 200);
    if (hasManim) missing.push("manim_render");
    if (hasWan) missing.push("wan_render");
  }
  return missing;
}

async function retryPhase(externalJobId, phase, serverIp) {
  const data = await proxyCall({ action: "retry_phase", job_id: externalJobId, phase, server_ip: serverIp });
  return data ? data.status !== "error" : false;
}

async function checkRegenStatus(externalJobId, serverIp) {
  const data = await proxyCall({ action: "regen_job_status", job_id: externalJobId, server_ip: serverIp });
  return data?.status || "idle";
}

async function createReport(job, subjectId, subjectName, category, status, createdBy) {
  const duration =
    job.submittedAt && job.completedAt
      ? Math.round((new Date(job.completedAt).getTime() - new Date(job.submittedAt).getTime()) / 1000)
      : null;
  const failed = Array.isArray(job.failedPhases) ? job.failedPhases : [];
  await query(
    `INSERT INTO public.auto_pipeline_reports
       (subject_id, subject_name, chapter_id, chapter_name, chapter_number, topic_id, topic_name, topic_number,
        document_id, external_job_id, server_ip, category, status, submitted_at, completed_at, duration_seconds,
        error_message, problem_description, retry_count, retry_details, failed_phases, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, $21, $22)`,
    [
      subjectId,
      subjectName,
      job.chapterId,
      job.chapterName,
      job.chapterNumber,
      job.topicId,
      job.topicName,
      job.topicNumber,
      job.documentId,
      job.externalJobId,
      job.serverIp,
      category,
      status,
      job.submittedAt,
      job.completedAt,
      duration,
      job.errorMessage,
      failed.length > 0 ? `Missing phases: ${failed.join(", ")}` : null,
      job.retryCount,
      job.retryDetails?.length > 0 ? JSON.stringify(job.retryDetails) : null,
      failed.length > 0 ? failed : null,
      createdBy,
    ]
  );
}

function getNextAvailableIp(selectedIps, slots, maxPerIp, excludeIps) {
  for (const ip of selectedIps) {
    if (excludeIps?.has(ip)) continue;
    if ((slots[ip] || 0) < maxPerIp) return ip;
  }
  return null;
}

async function syncRunStats(run) {
  const jobs = run.job_queue;
  await query(
    `UPDATE public.auto_pipeline_runs
        SET job_queue = $2::jsonb, completed_jobs = $3, good_jobs = $4, bad_jobs = $5, status = $6, updated_at = now()
      WHERE id = $1`,
    [
      run.id,
      JSON.stringify(jobs),
      jobs.filter((j) => DONE.includes(j.status)).length,
      jobs.filter((j) => j.status === "done_good").length,
      jobs.filter((j) => j.status === "done_bad").length,
      run.status,
    ]
  ).catch((e) => console.error(`[Worker] CRITICAL: Failed to sync run ${run.id}: ${e.message}`));
}

const isRepairActive = (j, now) =>
  j.status === "retrying" ||
  (j.status === "sanity_checking" && j.failedPhases?.length > 0 && j.lastPolledAt && now - new Date(j.lastPolledAt).getTime() < REPAIR_POLL_INTERVAL_MS);

async function processRun(run) {
  const jobs = run.job_queue;
  if (!jobs || jobs.length === 0) {
    run.status = "completed";
    await syncRunStats(run);
    return;
  }

  const selectedIps = run.selected_ips || [];
  if (selectedIps.length === 0) {
    console.error(`[Worker] Run ${run.id} has NO selected_ips! Cannot submit jobs. Cancelling run.`);
    await query("UPDATE public.auto_pipeline_runs SET status = 'cancelled', updated_at = now() WHERE id = $1", [run.id]);
    return;
  }
  const maxPerIp = run.pipeline_config?.max_jobs_per_ip || MAX_JOBS_PER_IP;
  const maxRetries = run.pipeline_config?.max_retries || MAX_RETRIES;
  let changed = false;
  const failedIpsThisCycle = new Set();

  const ipSlots = {};
  for (const ip of selectedIps) ipSlots[ip] = await countActiveJobsOnIp(ip);

  for (const job of jobs) {
    const now = Date.now();
    const otherRepairOnSameIp = (self) => jobs.some((j) => j !== self && j.serverIp === self.serverIp && isRepairActive(j, now));

    // QUEUED: submit with IP failover
    if (job.status === "queued") {
      let submitted = false;
      const triedIps = new Set();
      while (!submitted) {
        const ip = getNextAvailableIp(selectedIps, ipSlots, maxPerIp, new Set([...failedIpsThisCycle, ...triedIps]));
        if (!ip) break;

        triedIps.add(ip);
        job.status = "submitting";
        job.serverIp = ip;
        job.submittedAt = new Date().toISOString();
        ipSlots[ip] = (ipSlots[ip] || 0) + 1;

        const result = await submitJob(job, ip, run.subject_name, run.subject_id, run.created_by);
        if (result === "dedup_skip") {
          ipSlots[ip] = Math.max(0, (ipSlots[ip] || 0) - 1);
          job.status = "skipped";
          job.completedAt = new Date().toISOString();
          job.errorMessage = "Skipped: topic already has a completed job";
          submitted = true;
        } else if (result) {
          job.externalJobId = result.externalJobId;
          job.status = "processing";
          job.lastPolledAt = new Date().toISOString();
          submitted = true;
        } else {
          ipSlots[ip] = Math.max(0, (ipSlots[ip] || 0) - 1);
          failedIpsThisCycle.add(ip);
        }
      }

      if (!submitted && triedIps.size > 0) {
        job.status = "done_bad";
        job.errorMessage = `All IPs failed: ${[...triedIps].join(", ")}`;
        job.completedAt = new Date().toISOString();
        await createReport(job, run.subject_id, run.subject_name, "bad", "failed", run.created_by);
      }
      changed = true;
      continue;
    }

    // SUBMITTING: should not stay here; treat as processing
    if (job.status === "submitting") {
      if (job.externalJobId) {
        job.status = "processing";
        changed = true;
      }
      continue;
    }

    // PROCESSING: poll status
    if (job.status === "processing") {
      if (!job.externalJobId || !job.serverIp) {
        job.status = "done_bad";
        job.errorMessage = "Missing external job ID or server IP";
        job.completedAt = new Date().toISOString();
        await createReport(job, run.subject_id, run.subject_name, "bad", "failed", run.created_by);
        changed = true;
        continue;
      }

      const submittedTime = job.submittedAt ? new Date(job.submittedAt).getTime() : 0;
      if (Date.now() - submittedTime > STALE_PROCESSING_HOURS * 60 * 60 * 1000) {
        job.status = "done_bad";
        job.errorMessage = `Job stale: processing for over ${STALE_PROCESSING_HOURS} hours`;
        job.completedAt = new Date().toISOString();
        await createReport(job, run.subject_id, run.subject_name, "bad", "timeout", run.created_by);
        changed = true;
        continue;
      }

      const status = await pollJobStatus(job.externalJobId, job.serverIp);
      job.lastPolledAt = new Date().toISOString();
      changed = true;

      if (status === "completed" || status === "completed_with_errors") {
        job.status = "sanity_checking";
      } else if (status === "failed") {
        job.status = "done_bad";
        job.errorMessage = "Job failed during processing";
        job.completedAt = new Date().toISOString();
        await createReport(job, run.subject_id, run.subject_name, "bad", "failed", run.created_by);
      }
      continue;
    }

    // SANITY_CHECKING: run the sanity check (repairs poll every 3 minutes)
    if (job.status === "sanity_checking") {
      if (!job.externalJobId || !job.serverIp) continue;

      if (job.failedPhases?.length > 0 && job.lastPolledAt) {
        if (now - new Date(job.lastPolledAt).getTime() < REPAIR_POLL_INTERVAL_MS) continue;
      }
      if (job.failedPhases?.length > 0 && otherRepairOnSameIp(job)) continue;

      const sanity = await runSanityCheck(job.externalJobId, job.serverIp);
      job.lastPolledAt = new Date().toISOString();
      changed = true;

      if (!sanity) {
        job.status = "done_bad";
        job.errorMessage = "Sanity check request failed";
        job.completedAt = new Date().toISOString();
        await createReport(job, run.subject_id, run.subject_name, "bad", "failed", run.created_by);
        continue;
      }

      const missing = getMissingPhases(sanity);
      if (missing.length === 0) {
        job.status = "done_good";
        job.completedAt = new Date().toISOString();
        job.failedPhases = [];
        job.repairStartedAt = null;
        await query("UPDATE public.subject_topics SET ai_generated_video_url = $2 WHERE id = $1", [
          job.topicId,
          `http://${job.serverIp}:5005/player_v2/?job=${job.externalJobId}`,
        ]);
        await createReport(job, run.subject_id, run.subject_name, "good", "completed", run.created_by);
      } else {
        job.failedPhases = missing;
        const repairElapsed = job.repairStartedAt ? now - new Date(job.repairStartedAt).getTime() : 0;
        if (repairElapsed >= REPAIR_RETRY_THRESHOLD_MS) {
          if (job.retryCount < maxRetries) {
            job.status = "retrying";
          } else {
            job.status = "done_bad";
            job.completedAt = new Date().toISOString();
            job.errorMessage = `Failed after ${maxRetries} retries. Missing: ${missing.join(", ")}`;
            job.repairStartedAt = null;
            await createReport(job, run.subject_id, run.subject_name, "bad", "partial", run.created_by);
          }
        }
      }
      continue;
    }

    // RETRYING: retry the missing phases
    if (job.status === "retrying") {
      if (!job.externalJobId || !job.serverIp) continue;
      if (job.lastPolledAt && now - new Date(job.lastPolledAt).getTime() < REPAIR_POLL_INTERVAL_MS) continue;
      if (otherRepairOnSameIp(job)) continue;

      job.retryCount++;
      changed = true;

      const regenStatus = await checkRegenStatus(job.externalJobId, job.serverIp);
      if (regenStatus === "processing" || regenStatus === "running") {
        job.retryCount--; // not counted as an attempt
        job.lastPolledAt = new Date().toISOString();
        continue;
      }

      for (const phase of job.failedPhases) {
        const ok = await retryPhase(job.externalJobId, phase, job.serverIp);
        job.retryDetails.push({
          phase,
          attempt: job.retryCount,
          error: ok ? "" : "retry_phase failed",
          timestamp: new Date().toISOString(),
        });
      }

      job.status = "sanity_checking";
      job.repairStartedAt = new Date().toISOString();
      job.lastPolledAt = new Date().toISOString();
      continue;
    }

    // NEEDS_REPAIR: start a repair cycle
    if (job.status === "needs_repair") {
      if (!job.externalJobId || !job.serverIp) {
        job.status = "done_bad";
        job.errorMessage = "Cannot repair: missing external job ID or server IP";
        job.completedAt = new Date().toISOString();
        await createReport(job, run.subject_id, run.subject_name, "bad", "failed", run.created_by);
        changed = true;
        continue;
      }
      if (otherRepairOnSameIp(job)) {
        console.log(`[Worker] IP ${job.serverIp} busy with another repair, skipping needs_repair for topic="${job.topicName}"`);
        continue;
      }

      const sanity = await runSanityCheck(job.externalJobId, job.serverIp);
      changed = true;
      if (!sanity) {
        job.retryDetails.push({ phase: "sanity_check", attempt: 0, error: "Sanity check failed", timestamp: new Date().toISOString() });
        continue;
      }

      const missing = getMissingPhases(sanity);
      if (missing.length === 0) {
        job.status = "done_good";
        job.completedAt = new Date().toISOString();
        job.failedPhases = [];
        await query("UPDATE public.subject_topics SET ai_generated_video_url = $2 WHERE id = $1", [
          job.topicId,
          `http://${job.serverIp}:5005/player_v2/?job=${job.externalJobId}`,
        ]);
        await createReport(job, run.subject_id, run.subject_name, "good", "repaired", run.created_by);
      } else {
        job.failedPhases = missing;
        job.status = "retrying";
        job.repairStartedAt = new Date().toISOString();
        job.lastPolledAt = new Date().toISOString();
      }
      continue;
    }
  }

  const allDone = jobs.every((j) => DONE.includes(j.status));
  if (allDone) run.status = "completed";

  await syncRunStats(run);

  // Large runs update chapters_data only sometimes, to limit writes.
  const shouldUpdateChapters = allDone || jobs.length < 100 || Math.random() < 0.2;
  if (changed && shouldUpdateChapters) await updateChaptersData(run);
}

// Rebuilds chapters_data from job_queue, for the UI.
async function updateChaptersData(run) {
  const chapterMap = new Map();
  for (const job of run.job_queue) {
    if (!chapterMap.has(job.chapterId)) {
      chapterMap.set(job.chapterId, {
        chapterId: job.chapterId,
        chapterName: job.chapterName,
        chapterNumber: job.chapterNumber,
        jobs: [],
        status: "processing",
      });
    }
    chapterMap.get(job.chapterId).jobs.push({
      id: `${job.chapterId}_${job.topicId}`,
      chapterId: job.chapterId,
      chapterName: job.chapterName,
      chapterNumber: job.chapterNumber,
      topicId: job.topicId,
      topicName: job.topicName,
      topicNumber: job.topicNumber,
      documentId: job.documentId,
      documentName: job.documentName,
      sourceUrl: job.sourceUrl,
      sourceType: job.sourceType,
      fileName: job.fileName,
      status: job.status === "skipped" ? "already_done" : job.status,
      externalJobId: job.externalJobId,
      serverIp: job.serverIp,
      submittedAt: job.submittedAt,
      startedAt: job.submittedAt,
      completedAt: job.completedAt,
      retryCount: job.retryCount,
      retryDetails: job.retryDetails,
      errorMessage: job.errorMessage,
      sanityData: null,
      failedPhases: job.failedPhases,
    });
  }

  const chapters = Array.from(chapterMap.values()).sort((a, b) => a.chapterNumber - b.chapterNumber);
  const doneStatuses = ["done_good", "done_bad", "skipped", "already_done"];
  const activeStatuses = ["processing", "submitting", "sanity_checking", "retrying", "queued", "needs_repair"];
  for (const ch of chapters) {
    const allChDone = ch.jobs.every((j) => doneStatuses.includes(j.status));
    const anyProcessing = ch.jobs.some((j) => activeStatuses.includes(j.status));
    ch.status = allChDone ? "done" : anyProcessing ? "processing" : "pending";
  }

  await query("UPDATE public.auto_pipeline_runs SET chapters_data = $2::jsonb WHERE id = $1", [run.id, JSON.stringify(chapters)]);
}

async function allowed(req) {
  const key = process.env.SERVICE_KEY;
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (key && (bearer === key || req.headers["x-service-key"] === key)) return true;
  if (!bearer) return false;
  let userId = null;
  try {
    userId = jwt.verify(bearer, process.env.JWT_SECRET)?.sub || null;
  } catch {
    return false;
  }
  if (!userId) return false;
  const { rows } = await query("SELECT has_role($1::uuid, 'admin'::app_role) AS ok", [userId]);
  return !!rows[0]?.ok;
}

router.post("/", async (req, res) => {
  try {
    if (!(await allowed(req))) return res.status(401).json({ error: "Unauthorized" });

    // Process one run per call. Runs updated in the last 50 seconds are left alone (soft lock).
    const { rows: activeRuns } = await query(
      `SELECT id, subject_id, subject_name, status, selected_ips, job_queue, pipeline_config, current_chapter_index,
              total_jobs, completed_jobs, good_jobs, bad_jobs, created_by, updated_at
         FROM public.auto_pipeline_runs
        WHERE status = 'running' AND updated_at < $1
        ORDER BY started_at ASC
        LIMIT 1`,
      [new Date(Date.now() - 50_000).toISOString()]
    );

    if (activeRuns.length === 0) return res.json({ message: "No active runs", processed: 0 });

    let processed = 0;
    for (const rawRun of activeRuns) {
      const run = {
        id: rawRun.id,
        subject_id: rawRun.subject_id,
        subject_name: rawRun.subject_name,
        status: rawRun.status,
        selected_ips: Array.isArray(rawRun.selected_ips) ? rawRun.selected_ips : [],
        job_queue: Array.isArray(rawRun.job_queue) ? rawRun.job_queue : [],
        pipeline_config: rawRun.pipeline_config || { max_retries: 3, poll_interval_seconds: 10, max_jobs_per_ip: 2 },
        created_by: rawRun.created_by,
      };

      if (run.job_queue.length === 0) {
        const { rows } = await query("SELECT chapters_data FROM public.auto_pipeline_runs WHERE id = $1", [run.id]);
        const recovered = tryRecoverQueueFromChaptersData(rows[0]?.chapters_data);
        if (!recovered) {
          console.log(`[Worker] Run ${run.id} has empty job_queue and no recovery possible, skipping`);
          continue;
        }
        run.job_queue = recovered;
      }

      await processRun(run);
      processed++;
    }

    return res.json({ message: "OK", processed });
  } catch (err) {
    console.error(`[Worker] Unhandled error: ${err?.message}`);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});
