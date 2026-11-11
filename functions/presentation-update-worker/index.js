// Port of supabase/functions/presentation-update-worker.
// Bulk refresh of video_generation_jobs.presentation_json for queued runs. Meant to be called
// every minute by the server's scheduler (it replaces pg_cron).
//
// Authorisation: the caller must send `Authorization: Bearer <CRON_SECRET>`. Each review is fetched
// from video-generation-proxy on PUBLIC_BASE_URL with `Bearer <SERVICE_ROLE_KEY>`, which that route accepts.
import express from "express";
import { query } from "../_shared/db.js";

const SOFT_LOCK_SECONDS = 50;
const MAX_PER_INVOCATION = 10;
const UNREACHABLE_PATTERNS = ["No route to host", "Connection refused", "tcp connect error"];

export const router = express.Router();

const isUnreachable = (text) => UNREACHABLE_PATTERNS.some((p) => text.includes(p));

async function updateRun(runId, updates) {
  const entries = Object.entries({ ...updates, updated_at: new Date().toISOString() });
  const sets = [];
  const params = [];
  for (const [col, val] of entries) {
    params.push(col === "job_queue" ? JSON.stringify(val) : val);
    sets.push(`${col} = $${params.length}${col === "job_queue" ? "::jsonb" : ""}`);
  }
  params.push(runId);
  try {
    await query(`UPDATE public.presentation_update_runs SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
  } catch (err) {
    console.error(`[PRES_UPDATE] Failed to update run ${runId}:`, err.message);
  }
}

async function processRun(run) {
  const jobs = Array.isArray(run.job_queue) ? run.job_queue : [];
  if (jobs.length === 0) {
    console.log(`[PRES_UPDATE] Run ${run.id} has no jobs, marking completed`);
    await updateRun(run.id, { status: "completed" });
    return;
  }

  // Re-check run status (it may have been cancelled while this invocation was waiting).
  const { rows } = await query("SELECT status FROM public.presentation_update_runs WHERE id = $1", [run.id]);
  if (rows[0]?.status === "cancelled") {
    console.log(`[PRES_UPDATE] Run ${run.id} was cancelled, stopping`);
    return;
  }

  let idx = run.current_job_index ?? 0;
  let completed = run.completed_jobs ?? 0;
  let failed = run.failed_jobs ?? 0;
  let skipped = run.skipped_jobs ?? 0;
  let processed = 0;

  const serviceKey = process.env.SERVICE_ROLE_KEY || "";
  const publicBase = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

  while (idx < jobs.length && processed < MAX_PER_INVOCATION) {
    const job = jobs[idx];
    const jobNum = idx + 1;
    const total = jobs.length;
    console.log(`[PRES_UPDATE] Run ${run.id} | Job ${jobNum}/${total} | ${job.external_job_id} on ${job.server_ip}`);

    const markSkipped = () => {
      console.warn(`[PRES_UPDATE] Job ${jobNum}/${total}: ${job.external_job_id} -- SKIPPED: server unreachable`);
      job.status = "skipped";
      job.error_message = "Server unreachable";
      skipped++;
    };
    const markFailed = (msg) => {
      console.error(`[PRES_UPDATE] Job ${jobNum}/${total}: ${job.external_job_id} -- FAILED: ${msg}`);
      job.status = "failed";
      job.error_message = msg.substring(0, 500);
      failed++;
    };

    try {
      const resp = await fetch(`${publicBase}/functions/v1/video-generation-proxy`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
        body: JSON.stringify({ action: "review", job_id: job.external_job_id, server_ip: job.server_ip }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        if (isUnreachable(errText)) markSkipped();
        else markFailed(errText);
      } else {
        const reviewData = await resp.json();
        console.log(`[PRES_UPDATE] Job ${jobNum}/${total}: ${job.external_job_id} -- fetched OK, updating DB...`);
        try {
          await query(
            "UPDATE public.video_generation_jobs SET presentation_json = $1::jsonb WHERE id = $2",
            [JSON.stringify(reviewData), job.video_job_id]
          );
          console.log(`[PRES_UPDATE] Job ${jobNum}/${total}: ${job.external_job_id} -- DB updated successfully`);
          job.status = "completed";
          completed++;
        } catch (err) {
          console.error(`[PRES_UPDATE] Job ${jobNum}/${total}: ${job.external_job_id} -- DB update FAILED: ${err.message}`);
          job.status = "failed";
          job.error_message = err.message;
          failed++;
        }
      }
    } catch (err) {
      const errStr = err?.message || String(err);
      if (isUnreachable(errStr)) markSkipped();
      else markFailed(errStr);
    }

    idx++;
    processed++;
  }

  const newStatus = idx >= jobs.length ? "completed" : "processing";
  if (newStatus === "completed") {
    console.log(`[PRES_UPDATE] Run ${run.id} Complete: ${completed} updated, ${failed} failed, ${skipped} skipped`);
  }
  await updateRun(run.id, {
    status: newStatus,
    job_queue: jobs,
    current_job_index: idx,
    completed_jobs: completed,
    failed_jobs: failed,
    skipped_jobs: skipped,
  });
}

router.all("/", async (req, res) => {
  const json = (status, body) => res.status(status).json(body);
  if (req.method === "OPTIONS") return res.status(200).end();

  const secret = process.env.CRON_SECRET;
  if (!secret) return json(500, { error: "CRON_SECRET is not configured" });
  if (req.headers.authorization !== `Bearer ${secret}`) return json(401, { error: "Unauthorized" });

  try {
    const { rows: runs } = await query(
      `SELECT * FROM public.presentation_update_runs
        WHERE status = 'processing' ORDER BY created_at ASC LIMIT 3`
    );
    if (runs.length === 0) return json(200, { message: "No active runs" });

    console.log(`[PRES_UPDATE] Found ${runs.length} active run(s)`);
    for (const run of runs) {
      const updatedAt = new Date(run.updated_at).getTime();
      const now = Date.now();
      if (now - updatedAt < SOFT_LOCK_SECONDS * 1000) {
        console.log(`[PRES_UPDATE] Run ${run.id} soft-locked, skipping`);
        continue;
      }
      // Touch updated_at to claim this run.
      await query("UPDATE public.presentation_update_runs SET updated_at = now() WHERE id = $1", [run.id]);
      await processRun(run);
    }
    return json(200, { success: true });
  } catch (err) {
    console.error("[PRES_UPDATE] Unhandled error:", err);
    return json(500, { error: String(err) });
  }
});

export default router;
