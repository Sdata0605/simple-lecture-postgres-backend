// Port of supabase/functions/auto-publish-story-reels. Publishes completed STORY jobs into published_reels so
// they appear in the student Reels feed. A story job has one final video and no /reels manifest; it is
// confirmed through the job's /status endpoint (final_video_ready).
// Scheduled run. Caller must send SERVICE_KEY as Bearer token or x-service-key (the original had no check of its own).
// Config (env): REEL_DEFAULT_HOST (used when a reel job has no server_ip), REEL_DEFAULT_PORT (default 5006),
// STORY_VIDEO_PROXY_BASE (defaults to PUBLIC_BASE_URL + /functions/v1/v3-player-proxy).
import express from "express";
import { query } from "../_shared/db.js";

export const router = express.Router();

const DEFAULT_PORT = 5006;

const storyVideoUrl = (jobId) => {
  const base = (process.env.STORY_VIDEO_PROXY_BASE || `${(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "")}/functions/v1/v3-player-proxy`).replace(/\/$/, "");
  return `${base}/player/jobs/${jobId}/videos/presentation_final.mp4`;
};

function deriveStoryTitle(fileName) {
  if (!fileName) return "Story";
  const cleaned = fileName.replace(/^Story:\s*/i, "").replace(/[#*_`>]/g, "").trim();
  const firstLine = cleaned.split(/\r?\n/)[0].trim();
  const short = firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;
  return short || "Story";
}

router.post("/", async (req, res) => {
  const serviceKey = process.env.SERVICE_KEY;
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!serviceKey || (bearer !== serviceKey && req.headers["x-service-key"] !== serviceKey)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const summary = { jobs_scanned: 0, stories_detected: 0, published: 0, skipped: 0, errors: 0, details: [] };

  try {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const { rows: jobs } = await query(
      `SELECT id, job_id, server_ip, target_port, subject_id, document_id, file_name, completed_at, status
         FROM public.reel_jobs
        WHERE status = 'completed' AND completed_at >= $1 AND job_id IS NOT NULL`,
      [since]
    );
    summary.jobs_scanned = jobs.length;

    for (const job of jobs) {
      try {
        const ip = job.server_ip || process.env.REEL_DEFAULT_HOST;
        if (!ip) {
          summary.errors++;
          summary.details.push({ job: job.job_id, err: "no server_ip and REEL_DEFAULT_HOST not set" });
          continue;
        }
        const port = Number(job.target_port) || Number(process.env.REEL_DEFAULT_PORT) || DEFAULT_PORT;

        // Heuristic 1: the file name prefix marks a story. Heuristic 2: /status confirms it.
        const isStoryByName = /^story\s*:/i.test(job.file_name || "");
        const sResp = await fetch(`http://${ip}:${port}/job/${job.job_id}/status`);
        if (!sResp.ok) {
          summary.errors++;
          summary.details.push({ job: job.job_id, err: `status ${sResp.status}` });
          continue;
        }
        const sJson = await sResp.json();
        const finalReady = sJson?.final_video_ready === true;

        if (!isStoryByName && !finalReady) {
          summary.skipped++; // regular reels job, left to other publishers
          continue;
        }
        if (!finalReady) {
          summary.skipped++;
          continue;
        }
        summary.stories_detected++;

        let topicId = null;
        let chapterId = null;
        if (job.document_id) {
          const { rows } = await query("SELECT topic_id, chapter_id FROM public.ai_assistant_documents WHERE id = $1", [job.document_id]);
          topicId = rows[0]?.topic_id ?? null;
          chapterId = rows[0]?.chapter_id ?? null;
        }

        const devVideoUrl = storyVideoUrl(job.job_id);
        try {
          await query(
            `INSERT INTO public.published_reels
               (reel_job_id, external_job_id, document_id, subject_id, chapter_id, topic_id, reel_index, variant,
                variant_dir, title, video_url, is_published, published_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, 0, 'story', 'final', $7, $8, true, NULL, now())
             ON CONFLICT (external_job_id, reel_index, variant) DO UPDATE SET
               reel_job_id = EXCLUDED.reel_job_id, document_id = EXCLUDED.document_id, subject_id = EXCLUDED.subject_id,
               chapter_id = EXCLUDED.chapter_id, topic_id = EXCLUDED.topic_id, variant_dir = EXCLUDED.variant_dir,
               title = EXCLUDED.title, video_url = EXCLUDED.video_url, is_published = EXCLUDED.is_published,
               updated_at = now()`,
            [job.id, job.job_id, job.document_id, job.subject_id, chapterId, topicId, deriveStoryTitle(job.file_name), devVideoUrl]
          );
          summary.published++;
          summary.details.push({ job: job.job_id, published: true });
        } catch (e) {
          console.error("upsert error", e?.message);
          summary.errors++;
          summary.details.push({ job: job.job_id, err: e.message });
        }

        await query(
          `INSERT INTO public.reel_devserver_urls
             (reel_job_id, external_job_id, reel_index, variant, variant_dir, video_url, server_ip, target_port)
           VALUES ($1, $2, 0, 'story', 'final', $3, $4, $5)
           ON CONFLICT (external_job_id, reel_index, variant) DO UPDATE SET
             reel_job_id = EXCLUDED.reel_job_id, variant_dir = EXCLUDED.variant_dir, video_url = EXCLUDED.video_url,
             server_ip = EXCLUDED.server_ip, target_port = EXCLUDED.target_port`,
          [job.id, job.job_id, devVideoUrl, ip, port]
        );

        const vimeoUrl =
          sJson?.vimeo_url ||
          sJson?.final_video_vimeo_url ||
          (Array.isArray(sJson?.reels_vimeo) && sJson.reels_vimeo[0]?.vimeo_url) ||
          null;
        if (vimeoUrl) {
          const m = String(vimeoUrl).match(/vimeo\.com\/(\d+)/);
          await query(
            `INSERT INTO public.reel_vimeo_urls (reel_job_id, external_job_id, reel_index, variant, vimeo_url, vimeo_id)
             VALUES ($1, $2, 0, 'story', $3, $4)
             ON CONFLICT (external_job_id, reel_index, variant) DO UPDATE SET
               reel_job_id = EXCLUDED.reel_job_id, vimeo_url = EXCLUDED.vimeo_url, vimeo_id = EXCLUDED.vimeo_id`,
            [job.id, job.job_id, vimeoUrl, m?.[1] ?? null]
          );
        }
      } catch (e) {
        console.error("job loop error", job.job_id, e?.message);
        summary.errors++;
        summary.details.push({ job: job.job_id, err: String(e?.message || e) });
      }
    }

    return res.status(200).json(summary);
  } catch (err) {
    console.error("auto-publish-story-reels error", err?.message);
    return res.status(500).json({ error: String(err?.message || err), summary });
  }
});
