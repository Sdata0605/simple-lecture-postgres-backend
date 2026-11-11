// Port of supabase/functions/admin-backfill-subject. One-shot admin backfill: for every published,
// completed video_generation_jobs row of a subject whose presentation_json.sections is empty, fetches
// presentation.json from the render server and writes it back.
//
// POST /functions/v1/admin-backfill-subject
// Header: X-Admin-Token must equal BACKFILL_ADMIN_TOKEN. If that env var is not set, every request is
// refused (the original was open when the token was unset; this port fails closed).
// body: { subject }
import express from "express";
import { query } from "../_shared/db.js";

export const router = express.Router();

const RENDER_HOST = process.env.RENDER_HOST || "https://server1.simplelecture.com";
const FETCH_TIMEOUT_MS = 20_000;

const sectionsOf = (p) => (Array.isArray(p?.sections) ? p.sections : []);

router.post("/", async (req, res) => {
  const expected = process.env.BACKFILL_ADMIN_TOKEN;
  const provided = req.get("x-admin-token");
  if (!expected || provided !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const subjectName = String(req.body?.subject ?? "").trim();
  if (!subjectName) return res.status(400).json({ error: "subject required" });

  // Published, completed jobs with their subject name (inner joins, as in the original).
  let jobs;
  try {
    const r = await query(
      `SELECT j.id, j.external_job_id, j.presentation_json, ps.name AS subject_name
         FROM public.video_generation_jobs j
         JOIN public.ai_assistant_documents d ON d.id = j.document_id
         JOIN public.subject_chapters sc ON sc.id = d.chapter_id
         JOIN public.popular_subjects ps ON ps.id = sc.subject_id
        WHERE j.is_published = true AND j.status = 'completed'`
    );
    jobs = r.rows;
  } catch (e) {
    console.log("[ADMIN-BACKFILL] jobs-query-err", String(e?.message ?? e).slice(0, 200));
    return res.status(500).json({ error: e.message });
  }

  const inSubject = (j) => (j.subject_name ?? "").toLowerCase() === subjectName.toLowerCase();
  const target = jobs.filter((j) => inSubject(j) && sectionsOf(j.presentation_json).length === 0 && !!j.external_job_id);

  console.log(`[ADMIN-BACKFILL] subject=${subjectName} missing=${target.length}`);

  const report = [];
  let filled = 0;
  let failed = 0;

  for (const j of target) {
    const jobId = String(j.id);
    const ext = String(j.external_job_id);
    const url = `${RENDER_HOST}/video/${ext}/presentation.json`;
    const t0 = Date.now();
    try {
      const res2 = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res2.ok) {
        console.log(`[ADMIN-BACKFILL] cdn-fail jobId=${jobId} status=${res2.status}`);
        report.push({ jobId, ext, ok: false, reason: `http_${res2.status}` });
        failed++;
        continue;
      }
      const txt = await res2.text();
      const payload = JSON.parse(txt);
      const sections = sectionsOf(payload);
      if (sections.length === 0) {
        report.push({ jobId, ext, ok: false, reason: "empty_sections" });
        failed++;
        continue;
      }
      try {
        await query(
          "UPDATE public.video_generation_jobs SET presentation_json = $2, updated_at = now() WHERE id = $1",
          [jobId, JSON.stringify(payload)]
        );
      } catch (upErr) {
        console.log(`[ADMIN-BACKFILL] db-write-err jobId=${jobId} ${String(upErr.message).slice(0, 200)}`);
        report.push({ jobId, ext, ok: false, reason: `db:${upErr.message}` });
        failed++;
        continue;
      }
      filled++;
      console.log(
        `[ADMIN-BACKFILL] ok jobId=${jobId} sections=${sections.length} bytes=${txt.length} elapsedMs=${Date.now() - t0}`
      );
      report.push({ jobId, ext, ok: true, sections: sections.length, bytes: txt.length });
    } catch (err) {
      console.log(`[ADMIN-BACKFILL] err jobId=${jobId} ${String(err?.message ?? err).slice(0, 200)}`);
      report.push({ jobId, ext, ok: false, reason: err?.message ?? String(err) });
      failed++;
    }
  }

  // Post-check: how many jobs in this subject still have empty sections.
  const remaining = jobs.filter((j) => {
    if (!inSubject(j)) return false;
    const wasTarget = target.find((t) => String(t.id) === String(j.id));
    if (!wasTarget) return sectionsOf(j.presentation_json).length === 0;
    const r = report.find((x) => x.jobId === String(j.id));
    return !r?.ok;
  }).length;

  return res.json({
    ok: true,
    subject: subjectName,
    missing_before: target.length,
    filled,
    failed,
    still_empty_after: remaining,
    report,
  });
});

export default router;
