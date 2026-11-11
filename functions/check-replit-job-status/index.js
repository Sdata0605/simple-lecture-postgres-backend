// Port of supabase/functions/check-replit-job-status. Admin-only. Polls the external Mathpix/Replit
// OCR service for one document_processing_jobs row. When the job is COMPLETED, it stores the
// merged questions in parsed_questions_pending. FAILED, 404 (expired) and timed-out jobs are marked
// failed. POST { jobId }.
// The service base URL comes from MATHPIX_REPLIT_BASE_URL.
import express from "express";
import { query } from "../_shared/db.js";
import { userIdFromBearer, isAdminUser } from "../_shared/cdn-presentation-refresh-start-helper.js";
import { hookedFetch } from "../_shared/extract-dpp-helper.js";

export const router = express.Router();

const sendJson = (res, status, body) => res.status(status).type("application/json").send(JSON.stringify(body));

const OBJECTIVE_FORMATS = ["single_choice", "multiple_choice", "true_false", "fill_blank", "numerical"];

async function jobLog(jobId, level, message, details) {
  await query("INSERT INTO public.job_logs (job_id, log_level, message, details) VALUES ($1, $2, $3, $4::jsonb)", [
    jobId,
    level,
    message,
    JSON.stringify(details ?? null),
  ]);
}

async function jobUpdate(jobId, fields) {
  const sets = [];
  const params = [];
  for (const [col, val] of Object.entries(fields)) {
    params.push(col === "result_data" ? JSON.stringify(val) : val);
    sets.push(`${col} = $${params.length}${col === "result_data" ? "::jsonb" : ""}`);
  }
  params.push(jobId);
  await query(`UPDATE public.document_processing_jobs SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
}

async function documentUpdate(documentId, fields) {
  const sets = [];
  const params = [];
  for (const [col, val] of Object.entries(fields)) {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  }
  params.push(documentId);
  await query(`UPDATE public.uploaded_question_documents SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
}

const rawPreview = (resultData) => ({
  total_questions: resultData.total_questions,
  matched_count: resultData.matched_count,
  sample_items: (resultData.merged || []).slice(0, 2).map((x) => ({
    question_number: x.question_number,
    question_text: String(x.question_text || "").slice(0, 140),
  })),
});

// Splits "(a) text (b) text ..." into options, and returns the question text without them.
function parseOptions(questionText) {
  const optionsRegex = /\(([a-d])\)\s*([^(]+?)(?=\s*\([a-d]\)|$)/gi;
  const options = {};
  let match;
  while ((match = optionsRegex.exec(questionText)) !== null) {
    options[match[1]] = match[2].trim();
  }
  let cleanQuestionText = questionText.replace(/^\d+\.\s*/, "").trim();
  const optionsStartIndex = cleanQuestionText.search(/\([a-d]\)\s*/);
  if (optionsStartIndex > -1 && Object.keys(options).length > 0) {
    cleanQuestionText = cleanQuestionText.substring(0, optionsStartIndex).trim();
  }
  return { options, cleanQuestionText };
}

function replitBase() {
  const base = (process.env.MATHPIX_REPLIT_BASE_URL || "").replace(/\/$/, "");
  if (!base) throw new Error("MATHPIX_REPLIT_BASE_URL is not configured");
  return base;
}

router.post("/", async (req, res) => {
  const userId = userIdFromBearer(req);
  if (!userId) return sendJson(res, 401, { error: "Unauthorized" });
  if (!(await isAdminUser(userId))) return sendJson(res, 403, { error: "Forbidden" });

  try {
    const jobId = req.body?.jobId;
    if (!jobId) throw new Error("Job ID is required");

    let job;
    try {
      const { rows } = await query("SELECT * FROM public.document_processing_jobs WHERE id = $1", [jobId]);
      job = rows[0];
    } catch {
      job = undefined;
    }
    if (!job) throw new Error("Job not found");

    if (job.status === "completed" || job.status === "failed") {
      return sendJson(res, 200, { success: true, job, message: `Job is already ${job.status}` });
    }

    const replitJobId = job.result_data?.replit_job_id;
    if (!replitJobId) throw new Error("Replit job ID not found in job data");

    const base = replitBase();
    const statusResponse = await hookedFetch(`${base}/status/${replitJobId}`);

    // 404: the job expired or was deleted on the service.
    if (statusResponse.status === 404) {
      await jobUpdate(jobId, {
        status: "failed",
        error_message: "Job not found on Replit service (may have expired)",
        completed_at: new Date().toISOString(),
      });
      await documentUpdate(job.document_id, {
        status: "failed",
        error_message: "Processing job expired on external service",
      });
      await jobLog(jobId, "error", "Replit job not found (404)", { replit_job_id: replitJobId });
      return sendJson(res, 200, {
        success: false,
        status: "failed",
        message: "Job not found on Replit service (may have expired)",
      });
    }

    if (!statusResponse.ok) throw new Error(`Replit status check failed: ${statusResponse.status}`);

    const statusData = await statusResponse.json();
    const replitStatus = statusData.status;

    await jobLog(jobId, "info", `Status check: ${replitStatus}`, {
      replit_job_id: replitJobId,
      replit_status: replitStatus,
    });

    if (replitStatus === "PROCESSING") {
      await jobUpdate(jobId, {
        current_step: "Still processing on Replit service",
        progress_percentage: Math.min(80, (job.progress_percentage ?? 0) + 5),
      });
      return sendJson(res, 200, {
        success: true,
        status: "processing",
        replitStatus,
        message: "Job is still processing on Replit",
      });
    }

    if (replitStatus === "COMPLETED") {
      await jobUpdate(jobId, { current_step: "Fetching results from Replit", progress_percentage: 85 });

      const resultResponse = await hookedFetch(`${base}/api/educational-result/${replitJobId}`);
      if (!resultResponse.ok) throw new Error(`Failed to fetch results: ${resultResponse.status}`);

      const structuredData = await resultResponse.json();
      // The API nests the data under 'result'.
      const resultData = structuredData.result || structuredData;

      await jobLog(jobId, "info", "Results fetched successfully", {
        total_questions: resultData.total_questions,
        matched_count: resultData.matched_count,
      });

      const { rows: docRows } = await query(
        `SELECT category_id, subject_id, chapter_id, topic_id, subtopic_id
           FROM public.uploaded_question_documents WHERE id = $1`,
        [job.document_id]
      );
      const doc = docRows[0];
      if (!doc) throw new Error("Document not found");

      await jobUpdate(jobId, {
        current_step: "Parsing questions and inserting into database",
        progress_percentage: 90,
      });

      const merged = Array.isArray(resultData.merged) ? resultData.merged : [];
      let insertedCount = 0;

      for (const item of merged) {
        try {
          const questionText = item.question_text || "";
          const questionNumber = item.question_number;
          const { options, cleanQuestionText } = parseOptions(questionText);
          const hasOptions = Object.keys(options).length > 0;
          const questionFormat = hasOptions ? "single_choice" : "short_answer";
          const questionType = hasOptions || OBJECTIVE_FORMATS.includes(questionFormat) ? "objective" : "subjective";

          const solution = item.matched_solution;
          const correctAnswer = solution ? solution.answer_key : "";
          const explanation = solution ? solution.text : "";

          const questionImages = Array.isArray(item.question_images) ? item.question_images : [];
          const explanationImages = [];
          if (explanation) {
            const imageRegex = /!\[.*?\]\((\.\/images\/[^)]+)\)/g;
            let imgMatch;
            while ((imgMatch = imageRegex.exec(explanation)) !== null) {
              explanationImages.push(imgMatch[1]);
            }
          }

          try {
            await query(
              `INSERT INTO public.parsed_questions_pending
                 (document_id, category_id, subject_id, chapter_id, topic_id, subtopic_id, question_text,
                  question_format, question_type, options, correct_answer, explanation, question_images,
                  explanation_images, contains_formula, marks, difficulty)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, true, 1, 'Medium')`,
              [
                job.document_id,
                doc.category_id,
                doc.subject_id,
                doc.chapter_id,
                doc.topic_id,
                doc.subtopic_id,
                cleanQuestionText,
                questionFormat,
                questionType,
                hasOptions ? JSON.stringify(options) : null,
                correctAnswer || "",
                explanation || null,
                questionImages.length > 0 ? questionImages : null,
                explanationImages.length > 0 ? explanationImages : null,
              ]
            );
            insertedCount++;
          } catch (insertError) {
            await jobLog(jobId, "warn", `Failed to insert question ${questionNumber}`, {
              error: insertError.message,
              question_format: questionFormat,
              question_type: questionType,
              hasOptions,
              q_text_preview: cleanQuestionText.slice(0, 140),
            });
          }
        } catch (parseError) {
          await jobLog(jobId, "error", `Error parsing question ${item.question_number}`, {
            error: parseError instanceof Error ? parseError.message : "Unknown error",
          });
        }
      }

      if (merged.length > 0 && insertedCount === 0) {
        await jobUpdate(jobId, {
          status: "failed",
          progress_percentage: 100,
          questions_extracted: 0,
          completed_at: new Date().toISOString(),
          current_step: "Insert blocked by validation",
          error_message: "No questions inserted due to DB validation. Check job_logs for details.",
          result_data: {
            replit_job_id: replitJobId,
            total_questions: resultData.total_questions,
            matched_count: resultData.matched_count,
            inserted_count: 0,
            raw_preview: rawPreview(resultData),
          },
        });
        await documentUpdate(job.document_id, {
          status: "failed",
          error_message: "Validation failed - check job logs",
        });
        return sendJson(res, 200, { success: false, status: "failed", message: "No questions inserted due to validation errors" });
      }

      await jobUpdate(jobId, {
        status: "completed",
        progress_percentage: 100,
        questions_extracted: insertedCount,
        completed_at: new Date().toISOString(),
        current_step: `Completed: ${insertedCount} questions inserted`,
        result_data: {
          replit_job_id: replitJobId,
          total_questions: resultData.total_questions,
          matched_count: resultData.matched_count,
          inserted_count: insertedCount,
          raw_preview: rawPreview(resultData),
        },
      });
      await documentUpdate(job.document_id, {
        status: "completed",
        processing_completed_at: new Date().toISOString(),
      });
      await jobLog(jobId, "info", "Processing completed successfully", { questions_inserted: insertedCount });

      return sendJson(res, 200, {
        success: true,
        status: "completed",
        questionsInserted: insertedCount,
        message: `Successfully processed ${insertedCount} questions`,
      });
    }

    if (replitStatus === "FAILED") {
      await jobUpdate(jobId, {
        status: "failed",
        error_message: "Processing failed on Replit service",
        completed_at: new Date().toISOString(),
      });
      await documentUpdate(job.document_id, {
        status: "failed",
        error_message: "Processing failed on Replit",
      });
      return sendJson(res, 200, { success: false, status: "failed", message: "Job failed on Replit service" });
    }

    // Unknown status, or the job is older than 60 minutes.
    const jobAgeMinutes = (Date.now() - new Date(job.created_at).getTime()) / (1000 * 60);
    if (jobAgeMinutes > 60 || !["PROCESSING", "COMPLETED", "FAILED"].includes(replitStatus)) {
      await jobUpdate(jobId, {
        status: "failed",
        error_message: `Timed out or invalid external status: ${replitStatus}`,
        completed_at: new Date().toISOString(),
      });
      await documentUpdate(job.document_id, {
        status: "failed",
        error_message: "Processing timeout or invalid status",
      });
      return sendJson(res, 200, {
        success: false,
        status: "failed",
        message: `Job timed out or returned unknown status: ${replitStatus}`,
      });
    }

    return sendJson(res, 200, { success: true, status: replitStatus, message: `Current status: ${replitStatus}` });
  } catch (error) {
    console.error("Error checking job status:", error.message);
    return sendJson(res, 500, { error: error instanceof Error ? error.message : "Unknown error" });
  }
});
