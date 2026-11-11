// Port of supabase/functions/admin-refresh-job-presentation. Refreshes presentation_json for one
// video_generation_jobs row from the render server's CDN copy.
// The original had no auth check. Here every request must send X-Service-Key equal to ADMIN_SERVICE_KEY
// (if that env var is not set, every request is refused).
//
// POST /functions/v1/admin-refresh-job-presentation
// body: { job_id? , external_job_id? }
import crypto from "node:crypto";
import express from "express";
import { query } from "../_shared/db.js";

export const router = express.Router();

const RENDER_HOST = process.env.RENDER_HOST || "https://server1.simplelecture.com";

function serviceKeyOk(provided) {
  const expected = process.env.ADMIN_SERVICE_KEY;
  if (!expected || typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post("/", async (req, res) => {
  if (!serviceKeyOk(req.get("x-service-key"))) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const body = req.body ?? {};
  const jobId = body.job_id ?? null;
  const externalJobId = body.external_job_id ?? null;

  try {
    let row = null;
    if (jobId != null) {
      const r = await query("SELECT id, external_job_id FROM public.video_generation_jobs WHERE id = $1 LIMIT 1", [
        String(jobId),
      ]);
      row = r.rows[0] ?? null;
    } else if (externalJobId) {
      const r = await query(
        "SELECT id, external_job_id FROM public.video_generation_jobs WHERE external_job_id = $1 LIMIT 1",
        [String(externalJobId)]
      );
      row = r.rows[0] ?? null;
    }
    if (!row) return res.status(404).json({ error: "job not found" });

    const url = `${RENDER_HOST}/video/${row.external_job_id}/presentation.json`;
    const cdn = await fetch(url);
    if (!cdn.ok) return res.status(502).json({ error: `cdn_${cdn.status}`, url });
    const payload = await cdn.json();
    const secs = Array.isArray(payload?.sections) ? payload.sections : [];
    if (secs.length === 0) return res.status(422).json({ error: "empty_sections", url });

    try {
      await query("UPDATE public.video_generation_jobs SET presentation_json = $2, updated_at = now() WHERE id = $1", [
        row.id,
        JSON.stringify(payload),
      ]);
    } catch (upErr) {
      return res.status(500).json({ error: upErr.message });
    }

    return res.json({
      ok: true,
      job_id: row.id,
      external_job_id: row.external_job_id,
      sections: secs.length,
      section_ids: secs.map((s) => s?.section_id),
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message ?? "Unknown error" });
  }
});

export default router;
