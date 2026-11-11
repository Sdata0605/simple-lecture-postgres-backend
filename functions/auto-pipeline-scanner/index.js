// Port of supabase/functions/auto-pipeline-scanner. Server-side audit of the video pipeline.
//   action: 'init'         - create a run record, count topics, return the chapter list
//   action: 'scan_chapter' - scan one chapter's topics and append the results to the run
// Callers: an admin (Bearer JWT with the admin role) or SERVICE_KEY (Bearer or x-service-key).
// The original had no check of its own; this port adds it.
// The sanity check goes through video-generation-proxy at PUBLIC_BASE_URL with SERVICE_KEY.
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";

export const router = express.Router();

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

async function runSanityCheck(externalJobId, serverIp, topicName) {
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  try {
    const resp = await fetch(`${base}/functions/v1/video-generation-proxy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.SERVICE_KEY || ""}` },
      body: JSON.stringify({ action: "sanity_check", job_id: externalJobId, server_ip: serverIp }),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      console.log(`[Scanner] SANITY_FAIL | topic="${topicName}" | job=${externalJobId} | error=http_${resp.status}`);
      return null;
    }
    return await resp.json();
  } catch (err) {
    const reason = err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : String(err?.message || err);
    console.log(`[Scanner] SANITY_FAIL | topic="${topicName}" | job=${externalJobId} | error=${reason}`);
    return null;
  }
}

async function allowed(req) {
  const key = process.env.SERVICE_KEY;
  if (key && req.headers["x-service-key"] === key) return true;
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  if (key && token === key) return true;
  let userId = null;
  try {
    userId = jwt.verify(token, process.env.JWT_SECRET)?.sub || null;
  } catch {
    return false;
  }
  if (!userId) return false;
  const { rows } = await query("SELECT has_role($1::uuid, 'admin'::app_role) AS ok", [userId]);
  return !!rows[0]?.ok;
}

// ---- INIT: create a run, count topics, return the chapter list ----
async function handleInit(res, body) {
  const { subject_id, subject_name, chapter_ids, selected_ips } = body;
  if (!subject_id || !subject_name || !Array.isArray(chapter_ids) || chapter_ids.length === 0) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const { rows: chapters } = await query(
    "SELECT id, title, chapter_number FROM public.subject_chapters WHERE id = ANY($1::uuid[]) ORDER BY chapter_number",
    [chapter_ids]
  );
  if (chapters.length === 0) return res.status(400).json({ error: "No chapters found" });

  const { rows: countRows } = await query(
    "SELECT count(*)::int AS n FROM public.subject_topics WHERE chapter_id = ANY($1::uuid[])",
    [chapters.map((c) => c.id)]
  );
  const totalTopics = countRows[0].n || 0;

  let run;
  try {
    const { rows } = await query(
      `INSERT INTO public.auto_pipeline_runs
         (subject_id, subject_name, status, selected_ips, chapters_data, scan_results, current_chapter_index,
          total_jobs, completed_jobs, good_jobs, bad_jobs)
       VALUES ($1, $2, 'scanning', $3, '[]'::jsonb, '[]'::jsonb, 0, $4, 0, 0, 0)
       RETURNING id`,
      [subject_id, subject_name, JSON.stringify(selected_ips || []), totalTopics]
    );
    run = rows[0];
  } catch (e) {
    console.error("[Scanner] Failed to create run:", e?.message);
    return res.status(500).json({ error: "Failed to create scan run" });
  }

  console.log(`[Scanner] INIT | runId=${run.id} | chapters=${chapters.length} | totalTopics=${totalTopics}`);
  return res.json({
    runId: run.id,
    totalTopics,
    chapters: chapters.map((c) => ({ id: c.id, title: c.title, chapter_number: c.chapter_number })),
  });
}

// ---- SCAN_CHAPTER: scan one chapter's topics and append to the run ----
async function handleScanChapter(res, body) {
  const { run_id, chapter_id, subject_id } = body;
  if (!run_id || !chapter_id || !subject_id) {
    return res.status(400).json({ error: "Missing run_id, chapter_id, or subject_id" });
  }

  const { rows: runRows } = await query(
    "SELECT status, scan_results, completed_jobs, total_jobs FROM public.auto_pipeline_runs WHERE id = $1",
    [run_id]
  );
  const runData = runRows[0];
  if (!runData) return res.status(404).json({ error: "Run not found" });
  if (runData.status === "cancelled") {
    console.log(`[Scanner] CANCELLED | runId=${run_id}`);
    return res.json({ cancelled: true });
  }

  const existingResults = Array.isArray(runData.scan_results) ? runData.scan_results : [];
  let scannedCount = runData.completed_jobs || 0;
  const totalTopics = runData.total_jobs || 0;

  const { rows: chapterRows } = await query(
    "SELECT id, title, chapter_number FROM public.subject_chapters WHERE id = $1",
    [chapter_id]
  );
  const chapter = chapterRows[0];
  if (!chapter) return res.status(404).json({ error: "Chapter not found" });

  const { rows: allTopics } = await query(
    "SELECT id, title, topic_number, sequence_order FROM public.subject_topics WHERE chapter_id = $1 ORDER BY sequence_order",
    [chapter_id]
  );
  const chapterResults = [];
  console.log(`[Scanner] SCAN_CHAPTER | runId=${run_id} | ch=${chapter.chapter_number} | topics=${allTopics.length}`);

  for (const topic of allTopics) {
    scannedCount++;

    // Oldest document with a source for this topic; otherwise the oldest chapter-level document.
    const { rows: topicDocs } = await query(
      `SELECT id, display_name, file_name, source_url, source_type FROM public.ai_assistant_documents
        WHERE subject_id = $1 AND topic_id = $2 AND source_url IS NOT NULL
        ORDER BY created_at ASC`,
      [subject_id, topic.id]
    );
    let doc = topicDocs[0] || null;
    const allTopicDocIds = topicDocs.map((d) => d.id);
    if (!doc) {
      const { rows: chapterDocs } = await query(
        `SELECT id, display_name, file_name, source_url, source_type FROM public.ai_assistant_documents
          WHERE subject_id = $1 AND chapter_id = $2 AND topic_id IS NULL AND source_url IS NOT NULL
          ORDER BY created_at ASC LIMIT 1`,
        [subject_id, chapter_id]
      );
      doc = chapterDocs[0] || null;
      if (doc) allTopicDocIds.push(doc.id);
    }

    const baseScanResult = {
      topicId: topic.id,
      topicName: topic.title,
      topicNumber: typeof topic.topic_number === "string" ? parseInt(topic.topic_number, 10) || 0 : topic.topic_number,
      chapterId: chapter.id,
      chapterName: chapter.title,
      chapterNumber: chapter.chapter_number,
      documentId: doc?.id || null,
      documentName: doc?.display_name || doc?.file_name || null,
      sourceUrl: doc?.source_url || null,
      sourceType: doc?.source_type || null,
      fileName: doc?.file_name || null,
    };

    let result;
    if (!doc || !doc.source_url) {
      result = { ...baseScanResult, category: "no_document", selected: false, existingJobId: null, externalJobId: null, serverIp: null, missingPhases: [], sanityData: null };
    } else {
      const { rows: jobs } = await query(
        `SELECT id, status, external_job_id, server_ip FROM public.video_generation_jobs
          WHERE document_id = ANY($1::uuid[]) ORDER BY created_at DESC`,
        [allTopicDocIds]
      );
      const bestJob = jobs.find((j) => j.status === "completed") || jobs.find((j) => j.status === "completed_with_errors");

      if (!bestJob || !bestJob.external_job_id || !bestJob.server_ip) {
        result = { ...baseScanResult, category: "needs_new_job", selected: true, existingJobId: bestJob?.id || null, externalJobId: null, serverIp: null, missingPhases: [], sanityData: null };
      } else {
        const sanity = await runSanityCheck(bestJob.external_job_id, bestJob.server_ip, topic.title);
        if (!sanity) {
          result = { ...baseScanResult, category: "needs_repair", selected: true, existingJobId: bestJob.id, externalJobId: bestJob.external_job_id, serverIp: bestJob.server_ip, missingPhases: ["sanity_check_failed"], sanityData: null };
        } else {
          const missing = getMissingPhases(sanity);
          if (missing.length === 0) {
            result = { ...baseScanResult, category: "healthy", selected: false, existingJobId: bestJob.id, externalJobId: bestJob.external_job_id, serverIp: bestJob.server_ip, missingPhases: [], sanityData: sanity };
          } else {
            result = { ...baseScanResult, category: "needs_repair", selected: true, existingJobId: bestJob.id, externalJobId: bestJob.external_job_id, serverIp: bestJob.server_ip, missingPhases: missing, sanityData: sanity };
          }
        }
      }
    }

    chapterResults.push(result);
    // Saved after every topic, so the UI shows progress in real time.
    await query(
      "UPDATE public.auto_pipeline_runs SET scan_results = $2::jsonb, completed_jobs = $3 WHERE id = $1",
      [run_id, JSON.stringify([...existingResults, ...chapterResults]), scannedCount]
    );
  }

  const allResults = [...existingResults, ...chapterResults];
  const isComplete = scannedCount >= totalTopics;
  if (isComplete) {
    const count = (c) => allResults.filter((r) => r.category === c).length;
    console.log(`[Scanner] DONE | runId=${run_id} | total=${allResults.length} | healthy=${count("healthy")} | repair=${count("needs_repair")} | newJob=${count("needs_new_job")} | noDoc=${count("no_document")}`);
    await query(
      "UPDATE public.auto_pipeline_runs SET status = 'scan_complete', scan_results = $2::jsonb, completed_jobs = $3 WHERE id = $1",
      [run_id, JSON.stringify(allResults), scannedCount]
    );
  }

  return res.json({ done: isComplete, chapterTopics: chapterResults.length, totalScanned: scannedCount });
}

router.post("/", async (req, res) => {
  try {
    if (!(await allowed(req))) return res.status(401).json({ error: "Unauthorized" });
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const action = body.action || "legacy";
    if (action === "init") return await handleInit(res, body);
    if (action === "scan_chapter") return await handleScanChapter(res, body);
    return res.status(400).json({ error: "Use action: init or scan_chapter" });
  } catch (err) {
    console.error("[Scanner] ERROR:", err?.message);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});
