// Port of supabase/functions/cdn-presentation-refresh-start. Admin-only. Queues completed video jobs
// (all of them, or one by external_job_id) into cdn_presentation_refresh_runs for the worker to
// refresh from the render CDN. POST { only_empty, published_only, label, external_job_id }.
import express from "express";
import { query } from "../_shared/db.js";
import { userIdFromBearer, isAdminUser } from "../_shared/cdn-presentation-refresh-start-helper.js";

export const router = express.Router();

const PAGE = 1000;
const sendJson = (res, status, body) => res.status(status).type("application/json").send(JSON.stringify(body));

router.all("/", express.json({ limit: "1mb" }), async (req, res) => {
  if (req.method !== "POST") return sendJson(res, 405, { error: "method" });

  const b = req.body || {};
  const onlyEmpty = !!b.only_empty;
  const publishedOnly = !!b.published_only;
  let label = b.label ? String(b.label) : "CDN refresh — all completed jobs";
  const externalJobId = b.external_job_id ? String(b.external_job_id).trim() : null;

  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return sendJson(res, 401, { error: "missing auth" });
  const userId = userIdFromBearer(req);
  if (!userId) return sendJson(res, 401, { error: "unauthorized" });
  if (!(await isAdminUser(userId))) return sendJson(res, 403, { error: "not admin" });

  try {
    const jobs = [];

    if (externalJobId) {
      // Single-job mode: exactly one external_job_id.
      const { rows } = await query(
        "SELECT id, external_job_id, status FROM public.video_generation_jobs WHERE external_job_id = $1 LIMIT 1",
        [externalJobId]
      );
      const row = rows[0];
      if (!row) {
        return sendJson(res, 404, { error: `No video_generation_jobs row with external_job_id=${externalJobId}` });
      }
      jobs.push({
        video_job_id: String(row.id),
        external_job_id: String(row.external_job_id),
        status: "pending",
        error_message: null,
      });
      label = `CDN refresh — job ${externalJobId}`;
    } else {
      // Page through completed jobs, oldest first.
      for (let offset = 0; ; offset += PAGE) {
        const { rows } = await query(
          `SELECT id, external_job_id, presentation_json, is_published, status
             FROM public.video_generation_jobs
            WHERE status = 'completed' AND external_job_id IS NOT NULL
            ORDER BY created_at ASC, id ASC
            LIMIT $1 OFFSET $2`,
          [PAGE, offset]
        );
        if (rows.length === 0) break;
        for (const row of rows) {
          if (publishedOnly && row.is_published !== true) continue;
          if (onlyEmpty) {
            const secs = Array.isArray(row.presentation_json?.sections) ? row.presentation_json.sections : [];
            if (secs.length > 0) continue;
          }
          jobs.push({
            video_job_id: String(row.id),
            external_job_id: String(row.external_job_id),
            status: "pending",
            error_message: null,
          });
        }
        if (rows.length < PAGE) break;
      }
    }

    if (jobs.length === 0) return sendJson(res, 200, { ok: true, queued: 0, message: "No matching jobs" });

    const { rows: inserted } = await query(
      `INSERT INTO public.cdn_presentation_refresh_runs (status, job_queue, total_jobs, label, created_by)
       VALUES ('processing', $1::jsonb, $2, $3, $4)
       RETURNING id`,
      [JSON.stringify(jobs), jobs.length, label, userId]
    );

    return sendJson(res, 200, { ok: true, run_id: inserted[0].id, queued: jobs.length });
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
});
