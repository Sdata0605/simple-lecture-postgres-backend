// Port of supabase/functions/process-educational-pdfs.
// Sends a question PDF and a solutions PDF (both stored in the uploaded-question-documents bucket)
// to the external OCR service, and records the job in document_processing_jobs / job_logs.
//
// Changes from the original, all deliberate:
// - Files come from this server's storage (functions/_shared/storage.js), not Supabase Storage.
// - The OCR service URL comes from PROCESS_EDUCATIONAL_PDFS_URL (default: the original service).
// - The caller is authenticated before any document row is touched. The original could mark a
//   document as failed for an unauthenticated request; that is no longer possible.
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";
import { readFile } from "../_shared/storage.js";

const BUCKET = "uploaded-question-documents";
const DEFAULT_OCR_URL = "https://mathpix-ocr-llm-service-utuberpraveen.replit.app/process-educational-content";
const PUBLIC_PREFIX = "/storage/v1/object/public/";

export const router = express.Router();

const jsonRes = (res, body, status = 200) => res.status(status).json(body);

async function logJob(jobId, level, message, details) {
  await query(
    "INSERT INTO public.job_logs (job_id, log_level, message, details) VALUES ($1, $2, $3, $4::jsonb)",
    [jobId, level, message, details === undefined ? null : JSON.stringify(details)]
  );
}

async function updateJobProgress(jobId, percentage, step, status) {
  await query(
    `UPDATE public.document_processing_jobs
        SET progress_percentage = $2, current_step = $3, status = COALESCE($4, status), updated_at = now()
      WHERE id = $1`,
    [jobId, percentage, step, status ?? null]
  );
}

// "<origin>/storage/v1/object/public/<bucket>/<path>" -> bytes of <path> in our bucket.
async function downloadFile(fileUrl, fileName) {
  const parts = String(fileUrl).split(PUBLIC_PREFIX);
  if (parts.length < 2) throw new Error("Invalid file URL format");
  // The first segment is the bucket name in the URL; the bucket is fixed by this function.
  const storagePath = parts[1].split("/").slice(1).join("/");
  try {
    return await readFile(BUCKET, storagePath);
  } catch (err) {
    throw new Error(`Failed to download ${fileName}: ${err.message}`);
  }
}

async function userFromToken(authHeader) {
  const token = String(authHeader || "").replace("Bearer ", "");
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload.sub) return null;
    const { rows } = await query("SELECT id FROM auth.users WHERE id = $1", [payload.sub]);
    return rows[0] ? { id: rows[0].id } : null;
  } catch {
    return null;
  }
}

async function markFailed(documentId, errorMessage, error) {
  const { rows } = await query(
    "SELECT current_job_id FROM public.uploaded_question_documents WHERE id = $1 LIMIT 1",
    [documentId]
  );
  const jobId = rows[0]?.current_job_id;
  if (jobId) {
    await query(
      `UPDATE public.document_processing_jobs
          SET status = 'failed', error_message = $2, error_details = $3::jsonb, completed_at = now()
        WHERE id = $1`,
      [jobId, errorMessage, JSON.stringify({ error: errorMessage, stack: error instanceof Error ? error.stack : undefined })]
    );
    await logJob(jobId, "error", "Job failed", { error: errorMessage });
  }
  await query(
    "UPDATE public.uploaded_question_documents SET status = 'failed', error_message = $2, updated_at = now() WHERE id = $1",
    [documentId, errorMessage]
  );
}

router.all("/", async (req, res) => {
  if (req.method === "OPTIONS") return res.status(200).end();

  let documentId;
  try {
    const requestedId = req.body?.documentId;
    console.log("Processing document with OCR service:", requestedId);

    const user = await userFromToken(req.headers.authorization);
    if (!user) throw new Error("Unauthorized");
    // Only an authenticated request may touch this document's rows, so the id is set after auth.
    documentId = requestedId;

    const { rows: jobRows } = await query(
      `INSERT INTO public.document_processing_jobs
         (document_id, job_type, status, created_by, started_at, progress_percentage, current_step)
       VALUES ($1, 'mathpix_processing', 'running', $2, now(), 0, 'Initializing Replit service processing')
       RETURNING *`,
      [documentId, user.id]
    );
    const job = jobRows[0];
    if (!job) throw new Error("Failed to create job record: No job returned");

    await logJob(job.id, "info", "Job created", { job_id: job.id });

    await query(
      `UPDATE public.uploaded_question_documents
          SET status = 'processing', current_job_id = $2, processing_started_at = now()
        WHERE id = $1`,
      [documentId, job.id]
    );
    await updateJobProgress(job.id, 10, "Fetching PDFs from storage");

    const { rows: docRows } = await query(
      `SELECT questions_file_name, questions_file_url, solutions_file_name, solutions_file_url,
              category_id, subject_id, chapter_id, topic_id, subtopic_id
         FROM public.uploaded_question_documents WHERE id = $1`,
      [documentId]
    );
    const doc = docRows[0];
    if (!doc || !doc.questions_file_url || !doc.solutions_file_url) {
      throw new Error("Document not found or missing file URLs");
    }

    await logJob(job.id, "info", "Documents fetched", {
      questions_file: doc.questions_file_name,
      solutions_file: doc.solutions_file_name,
    });

    await updateJobProgress(job.id, 20, "Downloading PDFs");
    const questionsBytes = await downloadFile(doc.questions_file_url, doc.questions_file_name);
    const solutionsBytes = await downloadFile(doc.solutions_file_url, doc.solutions_file_name);
    await logJob(job.id, "info", "PDFs downloaded successfully");

    await updateJobProgress(job.id, 30, "Uploading PDFs to Replit service");
    const formData = new FormData();
    formData.append("questions_file", new Blob([questionsBytes]), doc.questions_file_name || "questions.pdf");
    formData.append("solutions_file", new Blob([solutionsBytes]), doc.solutions_file_name || "solutions.pdf");
    formData.append("use_llm", "false");

    const uploadResponse = await fetch(process.env.PROCESS_EDUCATIONAL_PDFS_URL || DEFAULT_OCR_URL, {
      method: "POST",
      body: formData,
    });
    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      throw new Error(`Replit service upload failed: ${uploadResponse.status} - ${errorText}`);
    }
    const uploadData = await uploadResponse.json();
    const replitJobId = uploadData.job_id;

    await logJob(job.id, "info", "PDFs uploaded to Replit", { replit_job_id: replitJobId });
    await query(
      "UPDATE public.document_processing_jobs SET result_data = $2::jsonb WHERE id = $1",
      [job.id, JSON.stringify({ replit_job_id: replitJobId })]
    );
    await updateJobProgress(job.id, 40, 'Job submitted to Replit. Use "Check Status" button to update.');

    return jsonRes(res, {
      success: true,
      jobId: job.id,
      replitJobId,
      message: 'Job submitted to Replit service. Status will be checked automatically or click "Check Status" button.',
    });
  } catch (error) {
    console.error("Error processing document:", error?.message);
    const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";

    if (documentId) {
      try {
        await markFailed(documentId, errorMessage, error);
      } catch (err) {
        console.error("Failed to record job failure:", err.message);
      }
    }
    return jsonRes(res, { error: errorMessage }, 500);
  }
});

export default router;
