// Port of supabase/functions/sync-pregen-cache. Copies ready presentations from the external AI
// Teaching API into pregen_question_cache. Run by a scheduler every 5 minutes.
// POST (or GET) with Authorization: Bearer <PREGEN_CRON_KEY>. The original had no check; the cron key
// is added here because the function writes to the cache. Env: AI_TEACHING_API_BASE (no default).
import express from "express";
import crypto from "node:crypto";
import { query } from "../_shared/db.js";

export const router = express.Router();

function cronAuthorized(req) {
  const key = process.env.PREGEN_CRON_KEY;
  const given = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!key || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.all("/", async (req, res) => {
  try {
    if (!cronAuthorized(req)) return res.status(401).json({ error: "Unauthorized" });

    const base = (process.env.AI_TEACHING_API_BASE || "").replace(/\/$/, "");
    if (!base) throw new Error("AI_TEACHING_API_BASE not configured");

    const apiRes = await fetch(`${base}/questions?status=ready`);
    if (!apiRes.ok) throw new Error(`AI API returned ${apiRes.status}`);

    const data = await apiRes.json();
    const readyJobs = Array.isArray(data) ? data : data?.questions ?? data?.items ?? data?.data ?? [];

    let synced = 0;
    let failed = 0;
    let skipped = 0;

    for (const job of readyJobs) {
      const qId = job.question_id || job.id;
      if (!qId) {
        skipped++;
        continue;
      }

      try {
        const { rows: existing } = await query("SELECT question_id FROM public.pregen_question_cache WHERE question_id = $1", [String(qId)]);
        if (existing.length) {
          skipped++;
          continue;
        }

        const presRes = await fetch(`${base}/ai-teaching-assistant`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "full",
            question: job.question_text,
            subjectId: job.subject_id,
            subjectName: job.subject_name || job.subject_title || "Unknown",
            topicId: job.topic_id,
            chapterId: job.chapter_id,
            language: "en-IN",
          }),
        });
        if (!presRes.ok) {
          failed++;
          continue;
        }
        const presentation = await presRes.json();

        await query(
          `INSERT INTO public.pregen_question_cache (question_id, subject_id, question_text, response_json)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (question_id)
           DO UPDATE SET subject_id = EXCLUDED.subject_id, question_text = EXCLUDED.question_text,
                         response_json = EXCLUDED.response_json, updated_at = now()`,
          [String(qId), job.subject_id ?? null, job.question_text ?? null, JSON.stringify(presentation)]
        );
        synced++;
      } catch (e) {
        console.error("Failed to sync a question:", e?.message);
        failed++;
      }
    }

    return res.json({ synced, failed, skipped, total: readyJobs.length });
  } catch (e) {
    return res.status(500).json({ error: e?.message });
  }
});

export default router;
