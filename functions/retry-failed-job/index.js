// Port of supabase/functions/retry-failed-job.
// Resets a failed document-processing job and re-triggers the matching pipeline step.
//
// - Caller: any signed-in user, as in the original (it had no role check).
// - Re-triggered steps are called on PUBLIC_BASE_URL with the caller's own token, which the target
//   routes already accept.
// - process-uploaded-document was removed from the repo, so a mathpix_processing retry fails with a
//   clear error after the job has been reset (the same ordering as the original).
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";

export const router = express.Router();

async function invokeRoute(name, body, authHeader) {
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  const res = await fetch(`${base}/functions/v1/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    return { error: { message: `${name} responded ${res.status}: ${text.slice(0, 300)}` } };
  }
  return { error: null };
}

async function userIdFromToken(authHeader) {
  const token = String(authHeader || "").replace("Bearer ", "");
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload.sub) return null;
    const { rows } = await query("SELECT id FROM auth.users WHERE id = $1", [payload.sub]);
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

router.all("/", async (req, res) => {
  if (req.method === "OPTIONS") return res.status(200).end();
  const json = (status, body) => res.status(status).json(body);

  try {
    const jobId = req.body?.jobId;
    console.log("Retrying job:", jobId);

    const authHeader = req.headers.authorization || "";
    const userId = await userIdFromToken(authHeader);
    if (!userId) throw new Error("Unauthorized");

    const { rows: jobRows } = await query("SELECT * FROM public.document_processing_jobs WHERE id = $1", [jobId]);
    const job = jobRows[0];
    if (!job) throw new Error("Job not found");

    if (job.retry_count >= job.max_retries) {
      throw new Error(`Maximum retry attempts (${job.max_retries}) exceeded`);
    }

    await query(
      `INSERT INTO public.job_logs (job_id, log_level, message, details) VALUES ($1, 'info', $2, $3::jsonb)`,
      [jobId, `Retry attempt ${job.retry_count + 1}/${job.max_retries}`, JSON.stringify({ previous_error: job.error_message })]
    );

    await query(
      `UPDATE public.document_processing_jobs
          SET status = 'pending', retry_count = $2, error_message = NULL, error_details = NULL,
              progress_percentage = 0, current_step = 'Retry scheduled', started_at = NULL, completed_at = NULL,
              updated_at = now()
        WHERE id = $1`,
      [jobId, job.retry_count + 1]
    );

    let invokeResult;
    if (job.job_type === "mathpix_processing") {
      invokeResult = { error: { message: "process-uploaded-document has been removed; this job type cannot be retried" } };
    } else if (job.job_type === "llm_extraction") {
      const { rows: docRows } = await query("SELECT * FROM public.uploaded_question_documents WHERE id = $1", [job.document_id]);
      const doc = docRows[0];
      if (!doc) throw new Error("Document not found for extraction retry");
      invokeResult = await invokeRoute("extract-questions-from-document", {
        documentId: job.document_id,
        categoryId: doc.category_id,
        subjectId: doc.subject_id,
        chapterId: doc.chapter_id,
        topicId: doc.topic_id,
        subtopicId: doc.subtopic_id,
      }, authHeader);
    } else if (job.job_type === "llm_verification") {
      invokeResult = await invokeRoute("llm-verify-questions", { documentId: job.document_id }, authHeader);
    } else {
      throw new Error(`Unknown job type: ${job.job_type}`);
    }

    if (invokeResult.error) {
      throw new Error(`Failed to invoke function: ${invokeResult.error.message}`);
    }

    await query(
      `INSERT INTO public.job_logs (job_id, log_level, message, details) VALUES ($1, 'info', $2, $3::jsonb)`,
      [jobId, "Job retry triggered successfully", JSON.stringify({ job_type: job.job_type })]
    );

    return json(200, {
      success: true,
      message: `Job retry ${job.retry_count + 1}/${job.max_retries} initiated`,
      jobId,
    });
  } catch (error) {
    console.error("Error retrying job:", error?.message);
    const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
    return res.status(500).json({ error: errorMessage });
  }
});

export default router;
