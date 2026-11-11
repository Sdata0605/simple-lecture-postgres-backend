// Port of supabase/functions/extract-questions-from-document. Creates a llm_extraction job for an
// uploaded document, hands it to the worker (process-llm-extraction) in the background and returns
// 202 at once. Errors mark the running job as failed. The caller may be signed out; the user id
// is taken from the Bearer token when one is valid.
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";

export const router = express.Router();

// Test hook: lets tests replace the worker call so no real request leaves the process.
export const hooks = { fetch: (...args) => fetch(...args) };

function userIdFromBearer(req) {
  const h = req.get("Authorization") || "";
  if (!h.startsWith("Bearer ")) return null;
  try {
    return jwt.verify(h.slice(7), process.env.JWT_SECRET)?.sub ?? null;
  } catch {
    return null;
  }
}

async function logJob(jobId, level, message, details) {
  await query(
    "INSERT INTO public.job_logs (job_id, log_level, message, details) VALUES ($1, $2, $3, $4)",
    [jobId, level, message, details ? JSON.stringify(details) : null],
  );
}

// Fire-and-forget: the worker runs on its own; failures are written to job_logs.
function invokeWorker(jobId, documentId) {
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  const url = `${base}/functions/v1/process-llm-extraction`;
  hooks
    .fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-service-key": process.env.SERVICE_KEY || "" },
      body: JSON.stringify({ jobId, documentId }),
      signal: AbortSignal.timeout(30_000),
    })
    .then(async (r) => {
      if (!r.ok) throw new Error(`worker responded ${r.status}`);
    })
    .catch((error) => {
      console.error("Failed to invoke worker function:", error?.message);
      logJob(jobId, "error", "Failed to invoke worker function", { error: error?.message }).catch(() => {});
    });
}

router.post("/", async (req, res) => {
  const documentId = req.body?.documentId;
  try {
    const userId = userIdFromBearer(req);

    const { rows } = await query(
      `INSERT INTO public.document_processing_jobs
         (document_id, job_type, status, current_step, total_steps, started_at, created_by)
       VALUES ($1, 'llm_extraction', 'running', 'Starting question extraction', 2, now(), $2)
       RETURNING *`,
      [documentId, userId],
    );
    const job = rows[0];

    invokeWorker(job.id, documentId);

    return res.status(202).json({
      success: true,
      started: true,
      jobId: job.id,
      documentId,
      message: "Extraction started. Track progress in Processing Jobs Monitor.",
    });
  } catch (error) {
    console.error("Error extracting questions:", error?.message);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    if (documentId) {
      try {
        const { rows: jobs } = await query(
          `SELECT id FROM public.document_processing_jobs
            WHERE document_id = $1 AND job_type = 'llm_extraction' AND status = 'running'
            ORDER BY created_at DESC LIMIT 1`,
          [documentId],
        );
        if (jobs[0]) {
          const jobId = jobs[0].id;
          await query(
            `UPDATE public.document_processing_jobs
                SET status = 'failed', error_message = $2, error_details = $3, completed_at = now()
              WHERE id = $1`,
            [
              jobId,
              errorMessage,
              JSON.stringify({ stack: error instanceof Error ? error.stack : undefined, name: error instanceof Error ? error.name : "Error" }),
            ],
          );
          await logJob(jobId, "error", `Extraction failed: ${errorMessage}`, {
            error_type: error instanceof Error ? error.name : "Error",
            stack: error instanceof Error ? error.stack : undefined,
          });
        }
      } catch (e) {
        console.error("Failed to record extraction failure:", e?.message);
      }
    }

    return res.status(500).json({ error: errorMessage });
  }
});
