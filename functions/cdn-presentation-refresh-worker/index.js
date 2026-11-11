// Port of supabase/functions/cdn-presentation-refresh-worker. Processes cdn_presentation_refresh_runs:
// fetches presentation.json for each queued job from the render CDN and stores it in
// video_generation_jobs.presentation_json. Was run by pg_cron every minute. Here it is called by a
// scheduler with header x-cron-key = CDN_REFRESH_CRON_KEY (fails closed when that is unset).
// The CDN host comes from CDN_RENDER_HOST.
import express from "express";
import { query } from "../_shared/db.js";
import { cronKeyOk, userIdFromBearer, isAdminUser } from "../_shared/cdn-presentation-refresh-start-helper.js";

export const router = express.Router();
export const hooks = { fetch: null };

const SOFT_LOCK_SECONDS = 45;
const MAX_PER_INVOCATION = 25;

const sendJson = (res, status, body) => res.status(status).type("application/json").send(JSON.stringify(body));

// The admin screen ("Run worker now") calls this with the signed-in admin's token, as well as the cron key.
async function callerAllowed(req) {
  if (cronKeyOk(req, "CDN_REFRESH_CRON_KEY")) return true;
  const userId = userIdFromBearer(req);
  return userId ? isAdminUser(userId).catch(() => false) : false;
}

router.post("/", async (req, res) => {
  if (!(await callerAllowed(req))) return sendJson(res, 401, { error: "Unauthorized" });

  const renderHost = (process.env.CDN_RENDER_HOST || "").replace(/\/$/, "");
  if (!renderHost) return sendJson(res, 500, { error: "CDN_RENDER_HOST is not configured" });

  try {
    const { rows: runs } = await query(
      `SELECT * FROM public.cdn_presentation_refresh_runs
        WHERE status = 'processing'
        ORDER BY created_at ASC
        LIMIT 3`
    );
    if (runs.length === 0) return sendJson(res, 200, { ok: true, message: "no active runs" });

    for (const run of runs) {
      const updatedAt = new Date(run.updated_at).getTime();
      if (Date.now() - updatedAt < SOFT_LOCK_SECONDS * 1000) {
        console.log(`[CDN_PRES] run ${run.id} soft-locked, skipping`);
        continue;
      }
      // Claim the run.
      await query("UPDATE public.cdn_presentation_refresh_runs SET updated_at = now() WHERE id = $1", [run.id]);
      await processRun(run, renderHost);
    }

    return sendJson(res, 200, { ok: true });
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
});

async function processRun(run, renderHost) {
  const jobs = Array.isArray(run.job_queue) ? run.job_queue : [];
  if (jobs.length === 0) {
    await query("UPDATE public.cdn_presentation_refresh_runs SET status = 'completed', updated_at = now() WHERE id = $1", [run.id]);
    return;
  }

  // Cancellation check.
  const { rows: fresh } = await query("SELECT status FROM public.cdn_presentation_refresh_runs WHERE id = $1", [run.id]);
  if (fresh[0]?.status === "cancelled") {
    console.log(`[CDN_PRES] run ${run.id} cancelled`);
    return;
  }

  let idx = run.current_job_index ?? 0;
  let completed = run.completed_jobs ?? 0;
  let failed = run.failed_jobs ?? 0;
  let skipped = run.skipped_jobs ?? 0;
  let processed = 0;

  while (idx < jobs.length && processed < MAX_PER_INVOCATION) {
    const job = jobs[idx];
    const jobNum = idx + 1;
    const total = jobs.length;
    const url = `${renderHost}/video/${job.external_job_id}/presentation.json`;

    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20_000);
      let res;
      try {
        res = await (hooks.fetch ?? fetch)(url, { signal: ctl.signal });
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        console.warn(`[CDN_PRES] ${jobNum}/${total} ${job.external_job_id} — http_${res.status}`);
        if (res.status === 404) {
          job.status = "skipped";
          job.error_message = "http_404 (missing on CDN)";
          skipped++;
        } else {
          job.status = "failed";
          job.error_message = `http_${res.status}`;
          failed++;
        }
      } else {
        const txt = await res.text();
        let payload = null;
        try {
          payload = JSON.parse(txt);
        } catch {
          // not JSON: treated as empty below
        }
        const secs = Array.isArray(payload?.sections) ? payload.sections : [];
        if (!payload || secs.length === 0) {
          job.status = "skipped";
          job.error_message = "empty_sections";
          skipped++;
        } else {
          try {
            await query(
              "UPDATE public.video_generation_jobs SET presentation_json = $1::jsonb, updated_at = now() WHERE id = $2",
              [JSON.stringify(payload), job.video_job_id]
            );
            job.status = "completed";
            completed++;
          } catch (upErr) {
            console.error(`[CDN_PRES] ${jobNum}/${total} db-fail ${upErr.message}`);
            job.status = "failed";
            job.error_message = `db:${upErr.message}`.slice(0, 400);
            failed++;
          }
        }
      }
    } catch (err) {
      const msg = err?.message || String(err);
      console.error(`[CDN_PRES] ${jobNum}/${total} err ${msg}`);
      job.status = "failed";
      job.error_message = msg.slice(0, 400);
      failed++;
    }

    idx++;
    processed++;
  }

  const newStatus = idx >= jobs.length ? "completed" : "processing";
  await query(
    `UPDATE public.cdn_presentation_refresh_runs
        SET status = $1, job_queue = $2::jsonb, current_job_index = $3, completed_jobs = $4,
            failed_jobs = $5, skipped_jobs = $6, updated_at = now()
      WHERE id = $7`,
    [newStatus, JSON.stringify(jobs), idx, completed, failed, skipped, run.id]
  );

  console.log(`[CDN_PRES] run ${run.id}: ${completed} ok, ${failed} failed, ${skipped} skipped, ${idx}/${jobs.length}`);
}
