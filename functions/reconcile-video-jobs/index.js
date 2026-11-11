// Port of supabase/functions/reconcile-video-jobs.
// Reconciles video_generation_jobs (status pending or processing) against the upstream pipeline's
// /status endpoint, through the video-generation-proxy or marketing-video-proxy routes on
// PUBLIC_BASE_URL. Meant to run every 5 minutes from the server's scheduler (it replaces pg_cron).
//
// Authorisation: the caller must send `Authorization: Bearer <CRON_SECRET>`. Proxy calls use the key
// each proxy accepts: SERVICE_ROLE_KEY for video-generation-proxy, SERVICE_KEY for marketing-video-proxy.
import express from "express";
import { query } from "../_shared/db.js";

const MAX_MISSES = 3;
const STALE_HOURS = 6;
const DEFAULT_PORT = 5005;
const MARKETING_PORT = 5006;

export const router = express.Router();

async function updateJob(id, fields) {
  const cols = Object.keys(fields);
  const sets = cols.map((c, i) => `${c} = $${i + 2}`);
  await query(`UPDATE public.video_generation_jobs SET ${sets.join(", ")} WHERE id = $1`, [id, ...cols.map((c) => fields[c])]);
}

// Calls the proxy route. Returns { data, error }; a non-2xx reply or a network error is an error.
async function invokeProxy(proxyName, body) {
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  const key = proxyName === "marketing-video-proxy" ? process.env.SERVICE_KEY : process.env.SERVICE_ROLE_KEY;
  try {
    const resp = await fetch(`${base}/functions/v1/${proxyName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key || ""}` },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return { data: null, error: new Error(`${proxyName} HTTP ${resp.status}`) };
    const text = await resp.text();
    return { data: text ? JSON.parse(text) : null, error: null };
  } catch (e) {
    return { data: null, error: e };
  }
}

async function reconcile(summary) {
  const { rows: jobs } = await query(
    `SELECT id, external_job_id, server_ip, target_port, status, progress, current_step, current_phase,
            updated_at, reconcile_miss_count
       FROM public.video_generation_jobs
      WHERE status IN ('pending', 'processing')`
  );
  summary.checked = jobs.length;

  for (const job of jobs) {
    if (!job.external_job_id) continue;

    // Stale guard: no progress for more than STALE_HOURS.
    const ageMs = Date.now() - new Date(job.updated_at).getTime();
    if (ageMs > STALE_HOURS * 3600 * 1000 && (job.progress ?? 0) === 0) {
      await updateJob(job.id, {
        status: "failed",
        error_message: `Timed out — no progress for ${STALE_HOURS}h`,
        completed_at: new Date(),
      });
      summary.failed++;
      summary.updated++;
      continue;
    }

    // Marketing-port jobs go through the marketing proxy.
    const jobPort = Number(job.target_port) || DEFAULT_PORT;
    const proxyName = jobPort === MARKETING_PORT ? "marketing-video-proxy" : "video-generation-proxy";
    const { data: statusData, error: upstreamError } = await invokeProxy(proxyName, {
      action: "status",
      job_id: job.external_job_id,
      server_ip: job.server_ip || process.env.DEFAULT_VIDEO_SERVER_IP || null,
      target_port: jobPort,
    });

    const notFound = upstreamError || !statusData || statusData.error || statusData.status === "not_found";
    if (notFound) {
      const newMiss = (job.reconcile_miss_count ?? 0) + 1;
      if (newMiss >= MAX_MISSES) {
        await updateJob(job.id, {
          status: "failed",
          error_message: "Upstream lost job (reconciler)",
          completed_at: new Date(),
          reconcile_miss_count: newMiss,
        });
        summary.failed++;
        summary.updated++;
      } else {
        await updateJob(job.id, { reconcile_miss_count: newMiss });
        summary.errors++;
      }
      continue;
    }

    const upstreamStatus = String(statusData.status || "").toLowerCase();
    const progress = typeof statusData.progress === "number" ? statusData.progress : job.progress;

    if (upstreamStatus === "completed" || upstreamStatus === "completed_with_errors") {
      await updateJob(job.id, {
        status: upstreamStatus,
        progress: upstreamStatus === "completed" ? 100 : progress,
        completed_at: new Date(),
        reconcile_miss_count: 0,
      });
      summary.completed++;
      summary.updated++;
    } else if (upstreamStatus === "failed" || upstreamStatus === "error") {
      await updateJob(job.id, {
        status: "failed",
        error_message: statusData.error || statusData.error_message || "Pipeline reported failure",
        completed_at: new Date(),
        reconcile_miss_count: 0,
      });
      summary.failed++;
      summary.updated++;
    } else {
      // Still running: refresh the fields and reset the miss counter.
      await updateJob(job.id, {
        status: "processing",
        progress: progress ?? 0,
        current_step: statusData.current_step ?? job.current_step,
        current_phase: statusData.current_phase ?? job.current_phase,
        reconcile_miss_count: 0,
      });
      summary.updated++;
    }
  }
}

router.all("/", async (req, res) => {
  if (req.method === "OPTIONS") return res.status(200).end();

  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(500).json({ error: "CRON_SECRET is not configured" });
  if (req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: "Unauthorized" });

  const summary = { checked: 0, updated: 0, completed: 0, failed: 0, errors: 0 };
  try {
    await reconcile(summary);
    return res.status(200).json(summary);
  } catch (err) {
    console.error("reconcile-video-jobs error", err?.message);
    return res.status(500).json({ error: String(err?.message || err), summary });
  }
});

export default router;
