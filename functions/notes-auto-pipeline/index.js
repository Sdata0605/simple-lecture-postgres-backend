// Port of supabase/functions/notes-auto-pipeline. Generates Notes for a batch of topics, one topic at
// a time, against an external Notes API. A run holds one item per topic. The pipeline advances by
// self-ticks: each tick claims one queued item (claim_notes_auto_pipeline_item), submits or polls it,
// and schedules the next tick.
//
// POST body: { action }
//   tick (internal, x-service-key)           : process the next item.
//   start | pause | resume | stop            : admin only (Bearer token, user_roles 'admin').
// Env: NOTES_PIPELINE_INTERNAL_SECRET (32+ chars, shared with allocate-topic-pyqs),
//      NOTES_API_DEFAULT_BASE (used when a request gives no api_base), SERVICE_KEY, PUBLIC_BASE_URL,
//      JWT_SECRET. Nothing here is hard-coded: the original default Notes API address is now env.
import express from "express";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { query } from "../_shared/db.js";

export const router = express.Router();

// Test hook: stubs every outbound HTTP call and skips the waits.
export const hooks = {
  fetch: (...args) => fetch(...args),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const DEFAULT_API_BASE = (process.env.NOTES_API_DEFAULT_BASE || "").replace(/\/+$/, "");
const REQUEST_TIMEOUT_MS = 420_000;
const TRANSIENT_RETRY_ATTEMPTS = 4;
const TRANSIENT_RETRY_BASE_MS = 2_000;
const TRANSIENT_WAIT_DELAY_MS = 30_000;

const sleep = (ms) => hooks.sleep(ms);
const publicBase = () => (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

function serviceKeyOk(req) {
  const svc = process.env.SERVICE_KEY || "";
  const got = req.get("x-service-key") || "";
  return Boolean(svc) && got.length === svc.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(svc));
}

function adminUserId(req) {
  const h = req.get("Authorization") || "";
  if (!h.startsWith("Bearer ")) return null;
  try {
    return jwt.verify(h.slice(7), process.env.JWT_SECRET)?.sub ?? null;
  } catch {
    return null;
  }
}

// Objects and arrays go in as JSON. Everything else is passed as is.
const serialise = (v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v);

// UPDATE public.<table> SET patch WHERE where. A null where value means IS NULL, an array means ANY.
async function updateRows(table, patch, where, { returning = "" } = {}) {
  const params = [];
  const sets = Object.entries(patch).map(([k, v]) => {
    params.push(serialise(v));
    return `${k} = $${params.length}`;
  });
  const conds = Object.entries(where).map(([k, v]) => {
    if (v === null) return `${k} IS NULL`;
    params.push(v);
    return Array.isArray(v) ? `${k} = ANY($${params.length})` : `${k} = $${params.length}`;
  });
  const sql = `UPDATE public.${table} SET ${sets.join(", ")} WHERE ${conds.join(" AND ")}${returning ? ` RETURNING ${returning}` : ""}`;
  const { rows } = await query(sql, params);
  return rows;
}

const countRows = async (sql, params) => (await query(sql, params)).rows[0]?.n ?? 0;

function background(promise, label) {
  promise.catch((error) => console.error(`[notes-auto-pipeline] ${label}`, error?.message));
}

const normalizeBody = (text) => {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
};

const isTransientNetworkError = (error) => {
  const message = error instanceof Error ? error.message : String(error || "");
  return /(tcp connect error|connection timed out|os error 110|os error 111|connection refused|network is unreachable|no route to host|temporarily unavailable|dns error|name or service not known|broken pipe|connection reset|error sending request for url|upstream timed out|timed out after)/i.test(
    message,
  );
};

const isRetryableHttpStatus = (status) => status === 408 || status === 425 || status === 429 || status >= 500;

// Fetch with retries for transient failures. Resolves to { status, body } or throws.
async function requestJson(url, init = {}, options = {}) {
  const maxAttempts = options.retries ?? TRANSIENT_RETRY_ATTEMPTS;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await hooks.fetch(url, { ...init, signal: controller.signal });
      const text = await response.text();
      if (!response.ok && isRetryableHttpStatus(response.status) && attempt < maxAttempts) {
        console.warn(`[notes-auto-pipeline] retryable HTTP ${response.status} (attempt ${attempt}/${maxAttempts})`);
        await sleep(TRANSIENT_RETRY_BASE_MS * attempt);
        continue;
      }
      return { status: response.status, body: normalizeBody(text) };
    } catch (error) {
      lastError =
        error instanceof Error && error.name === "AbortError"
          ? new Error(`Upstream timed out after ${REQUEST_TIMEOUT_MS / 1000}s for ${url}`)
          : error;
      const retryable = isTransientNetworkError(lastError);
      console.warn(`[notes-auto-pipeline] fetch failed (attempt ${attempt}/${maxAttempts}): ${lastError?.message}`);
      if (!retryable || attempt >= maxAttempts) throw lastError;
      await sleep(TRANSIENT_RETRY_BASE_MS * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || "Upstream fetch failed"));
}

const freshReadUrl = (url) => `${url}${url.includes("?") ? "&" : "?"}_notes_ts=${Date.now()}`;

export function findDocumentId(value) {
  if (!value || typeof value !== "object") return null;
  for (const key of ["document_id", "doc_id", "id"]) {
    if (typeof value[key] === "string" && value[key]) return value[key];
  }
  for (const key of ["document", "result", "data"]) {
    const nested = findDocumentId(value[key]);
    if (nested) return nested;
  }
  return null;
}

const getQueueResponse = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value || {};
  if ("queue_response" in value) return value.queue_response || {};
  if ("latest_status" in value || "final_status" in value || "queued" in value) return {};
  return value;
};

export function readGenerationState(body) {
  const documentStatus = String(body.document_status || body.status || "").toLowerCase();
  const topicsDone = Number(body.topics_done || 0);
  const topicsPending = Number(body.topics_pending || 0);
  const topicsFailed = Number(body.topics_failed || 0);
  const failed = topicsFailed > 0 || /(fail|error|cancel|stopp)/.test(documentStatus);
  const countersComplete = topicsDone > 0 && topicsPending === 0 && topicsFailed === 0;
  const completed =
    !failed &&
    (countersComplete ||
      /(done|complete|notes_ready|generated)/.test(documentStatus) ||
      (documentStatus === "ready" && topicsDone > 0 && topicsPending === 0));
  return { documentStatus, topicsDone, topicsPending, topicsFailed, failed, completed };
}

async function fetchGeneratedResult(apiBase, documentId) {
  const documentResult = await requestJson(
    freshReadUrl(`${apiBase}/notes/document/${encodeURIComponent(documentId)}`),
    { headers: { "Cache-Control": "no-cache" } },
  );
  if (documentResult.status !== 200) {
    throw new Error(`Generated Notes retrieval returned HTTP ${documentResult.status}.`);
  }
  const documentBody = documentResult.body;
  const topics = Array.isArray(documentBody.topics) ? documentBody.topics : [];
  const topicResponses = [];
  for (const topic of topics) {
    const topicId = String(topic?.topic_note_id || "");
    if (!topicId) continue;
    const topicResult = await requestJson(freshReadUrl(`${apiBase}/notes/topic/${encodeURIComponent(topicId)}`), {
      headers: { "Cache-Control": "no-cache" },
    });
    if (topicResult.status !== 200) {
      throw new Error(`Generated topic retrieval returned HTTP ${topicResult.status}.`);
    }
    topicResponses.push({ topic_note_id: topicId, http_status: topicResult.status, response: topicResult.body });
  }
  return { document_http_status: documentResult.status, document: documentBody, topics: topicResponses };
}

export function toApiFormat(format) {
  if (["single_choice", "multiple_choice", "mcq"].includes(format || "")) return "mcq";
  if (format === "true_false") return "true_false";
  if (format === "short_answer") return "short_answer";
  return "long_answer";
}

export function toApiDifficulty(difficulty) {
  const value = difficulty?.toLowerCase();
  if (value === "easy" || value === "low") return "Easy";
  if (value === "hard" || value === "advanced") return "Hard";
  return "Medium";
}

export function extractContentMarkdown(doc, topic) {
  const content = doc?.full_content;
  const parsed = content && typeof content === "object" && !Array.isArray(content) ? content : null;
  return String(
    parsed?.content_markdown ||
      parsed?.markdown ||
      parsed?.content ||
      parsed?.text ||
      (typeof content === "string" ? content : "") ||
      topic.content_markdown ||
      topic.notes_markdown ||
      "",
  );
}

async function invokeAllocator(pipelineSecret, body) {
  const response = await requestJson(`${publicBase()}/functions/v1/allocate-topic-pyqs`, {
    method: "POST",
    headers: {
      "x-notes-pipeline-internal": pipelineSecret,
      "x-service-key": process.env.SERVICE_KEY || "",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (response.status !== 200) {
    const detail = response.body?.error || JSON.stringify(response.body);
    throw new Error(`PYQ allocation failed (${response.status}): ${detail}`);
  }
  return response.body;
}

async function failRun(item, message, patch = {}) {
  const now = new Date().toISOString();
  await updateRows(
    "notes_auto_pipeline_items",
    { ...patch, status: "failed", error_message: message, completed_at: now, updated_at: now },
    { id: item.id },
  );
  await updateRows(
    "notes_auto_pipeline_items",
    {
      status: "stopped",
      error_message: "Pipeline stopped after a previous topic failed.",
      completed_at: now,
      updated_at: now,
    },
    { run_id: item.run_id, status: "queued" },
  );
  await updateRows(
    "notes_auto_pipeline_runs",
    {
      status: "failed",
      failed_items: 1,
      error_message: message,
      current_topic_id: item.topic_id,
      completed_at: now,
      updated_at: now,
    },
    { id: item.run_id },
  );
}

function scheduleNextTick(delayMs = 15_000) {
  background(
    (async () => {
      if (delayMs > 0) await sleep(delayMs);
      await hooks.fetch(`${publicBase()}/functions/v1/notes-auto-pipeline`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-service-key": process.env.SERVICE_KEY || "" },
        body: JSON.stringify({ action: "tick" }),
      });
    })(),
    "next tick failed",
  );
}

async function continueWaitingAfterTransient(item, message) {
  console.warn("[notes-auto-pipeline] transient notes API issue; will retry", item.id, message);
  await updateRows(
    "notes_auto_pipeline_items",
    {
      generation_response: {
        queue_response: getQueueResponse(item.generation_response),
        latest_status: { waiting_on_notes_api: true, transient_error: message.slice(0, 500), at: new Date().toISOString() },
      },
      error_message: null,
      updated_at: new Date().toISOString(),
    },
    { id: item.id, status: "processing" },
  );
  scheduleNextTick(TRANSIENT_WAIT_DELAY_MS);
  return { processed: true, waiting: true, transient: true, item_id: item.id, message };
}

async function requeueAfterTransient(item, message, patch = {}) {
  console.warn("[notes-auto-pipeline] transient submit failure; re-queueing topic", item.id, message);
  const now = new Date().toISOString();
  await updateRows(
    "notes_auto_pipeline_items",
    {
      ...patch,
      status: "queued",
      error_message: null,
      started_at: null,
      completed_at: null,
      generation_response: {
        queue_response: getQueueResponse(item.generation_response),
        latest_status: { waiting_on_notes_api: true, transient_error: message.slice(0, 500), at: now },
      },
      updated_at: now,
    },
    { id: item.id },
  );
  await updateRows(
    "notes_auto_pipeline_runs",
    { current_topic_id: null, updated_at: now },
    { id: item.run_id, status: "running" },
  );
  scheduleNextTick(TRANSIENT_WAIT_DELAY_MS);
  return { processed: true, waiting: true, transient: true, requeued: true, item_id: item.id, message };
}

async function finishItem(item, statusResponse, finalResponse) {
  const now = new Date().toISOString();
  await updateRows(
    "notes_auto_pipeline_items",
    {
      status: "submitted",
      generation_response: { queue_response: getQueueResponse(item.generation_response), final_status: statusResponse },
      final_response_http_status: 200,
      final_response: finalResponse,
      completed_at: now,
      updated_at: now,
    },
    { id: item.id },
  );

  const remaining = await countRows(
    "SELECT count(*)::int AS n FROM public.notes_auto_pipeline_items WHERE run_id = $1 AND status = 'queued'",
    [item.run_id],
  );
  const completed = await countRows(
    "SELECT count(*)::int AS n FROM public.notes_auto_pipeline_items WHERE run_id = $1 AND status = 'submitted'",
    [item.run_id],
  );
  const { rows: runRows } = await query("SELECT status FROM public.notes_auto_pipeline_runs WHERE id = $1", [item.run_id]);
  const isPaused = runRows[0]?.status === "paused";
  const newStatus = remaining === 0 ? "completed" : isPaused ? "paused" : "running";

  await updateRows(
    "notes_auto_pipeline_runs",
    {
      status: newStatus,
      completed_items: completed || 0,
      current_topic_id: null,
      completed_at: remaining === 0 ? now : null,
      updated_at: now,
    },
    { id: item.run_id },
  );

  if ((remaining || 0) > 0 && !isPaused) scheduleNextTick(0);
}

// Looks for a submitted item whose final result was never stored, and stores it when Notes is done.
async function backfillMissingResult() {
  const { rows } = await query(
    `SELECT i.id, i.external_document_id, r.api_base
       FROM public.notes_auto_pipeline_items i
       JOIN public.notes_auto_pipeline_runs r ON r.id = i.run_id
      WHERE i.status = 'submitted' AND i.final_response IS NULL AND i.external_document_id IS NOT NULL
      ORDER BY i.created_at ASC LIMIT 1`,
  );
  const item = rows[0];
  if (!item?.external_document_id) return { processed: false };

  const apiBase = String(item.api_base || DEFAULT_API_BASE).replace(/\/+$/, "");
  try {
    const statusResult = await requestJson(
      freshReadUrl(`${apiBase}/notes/status/${encodeURIComponent(String(item.external_document_id))}`),
      { headers: { "Cache-Control": "no-cache" } },
    );
    if (statusResult.status !== 200) return { processed: false, backfill_status: statusResult.status };
    const state = readGenerationState(statusResult.body);
    if (!state.completed) return { processed: false, backfill_waiting: true };

    const finalResponse = await fetchGeneratedResult(apiBase, String(item.external_document_id));
    await updateRows(
      "notes_auto_pipeline_items",
      {
        generation_response: { final_status: statusResult.body },
        final_response_http_status: 200,
        final_response: finalResponse,
        updated_at: new Date().toISOString(),
      },
      { id: item.id },
    );
    return { processed: true, backfilled: true, item_id: item.id };
  } catch (error) {
    if (isTransientNetworkError(error)) {
      console.warn("[notes-auto-pipeline] backfill deferred due to transient notes API issue", error?.message);
      return { processed: false, transient: true };
    }
    throw error;
  }
}

// Handles one queue item. Returns a small status object, which the tick endpoint sends back.
async function processNext(pipelineSecret) {
  const { rows: claimedRows } = await query("SELECT * FROM public.claim_notes_auto_pipeline_item()");
  const item = claimedRows[0];
  if (!item) return await backfillMissingResult();

  try {
    const { rows: runRows } = await query(
      "SELECT id, api_base, status, stop_requested FROM public.notes_auto_pipeline_runs WHERE id = $1",
      [item.run_id],
    );
    const run = runRows[0];
    if (!run || (run.status !== "running" && run.status !== "paused") || run.stop_requested) {
      throw new Error("Pipeline was stopped before this topic could be submitted.");
    }

    const apiBase = String(run.api_base || DEFAULT_API_BASE).replace(/\/+$/, "");

    // The topic was submitted and generation was started: poll until it is done.
    if (item.external_document_id && item.generation_http_status === 200) {
      let statusResult;
      try {
        statusResult = await requestJson(
          freshReadUrl(`${apiBase}/notes/status/${encodeURIComponent(String(item.external_document_id))}`),
          { headers: { "Cache-Control": "no-cache" } },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isTransientNetworkError(error)) return await continueWaitingAfterTransient(item, message);
        throw error;
      }

      if (statusResult.status !== 200) {
        if (isRetryableHttpStatus(statusResult.status)) {
          return await continueWaitingAfterTransient(
            item,
            `Notes status temporarily unavailable (HTTP ${statusResult.status}).`,
          );
        }
        await failRun(item, `Notes status returned HTTP ${statusResult.status}.`, {
          generation_response: {
            queue_response: getQueueResponse(item.generation_response),
            final_status: statusResult.body,
          },
        });
        return { processed: true, failed: true };
      }

      const statusBody = statusResult.body;
      const generationState = readGenerationState(statusBody);
      const { documentStatus, failed, completed } = generationState;

      if (failed) {
        await failRun(item, `Notes generation finished with status '${documentStatus || "failed"}'.`, {
          generation_response: { queue_response: getQueueResponse(item.generation_response), final_status: statusBody },
        });
        return { processed: true, failed: true };
      }

      const shouldProbeGeneratedResult = !failed && generationState.topicsPending === 0 && generationState.topicsFailed === 0;
      if (completed || shouldProbeGeneratedResult) {
        try {
          const finalResponse = await fetchGeneratedResult(apiBase, String(item.external_document_id));
          const generatedTopics = Array.isArray(finalResponse?.topics) ? finalResponse.topics : [];
          if (generatedTopics.length > 0) {
            await finishItem(item, statusBody, finalResponse);
            return { processed: true, failed: false, completed: true, item_id: item.id };
          }
          if (completed) {
            throw new Error("Notes status completed but no generated topic response was available.");
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (isTransientNetworkError(error) || !completed) {
            console.warn("[notes-auto-pipeline] generated result is not available yet; continuing to wait", message);
            if (isTransientNetworkError(error)) return await continueWaitingAfterTransient(item, message);
          } else {
            await failRun(item, message, {
              generation_response: { queue_response: getQueueResponse(item.generation_response), final_status: statusBody },
            });
            return { processed: true, failed: true };
          }
        }
      }

      await updateRows(
        "notes_auto_pipeline_items",
        {
          generation_response: { queue_response: getQueueResponse(item.generation_response), latest_status: statusBody },
          error_message: null,
          updated_at: new Date().toISOString(),
        },
        { id: item.id },
      );
      scheduleNextTick();
      return { processed: true, waiting: true, item_id: item.id, remote_status: documentStatus, generation_state: generationState };
    }

    // Import already created a remote document, but generate did not finish cleanly: retry generate.
    if (item.external_document_id && item.generation_http_status !== 200) {
      const documentId = String(item.external_document_id);
      let generated;
      try {
        generated = await requestJson(`${apiBase}/notes/generate/${encodeURIComponent(documentId)}`, { method: "POST" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isTransientNetworkError(error)) return await continueWaitingAfterTransient(item, message);
        throw error;
      }

      if (generated.status !== 200) {
        if (isRetryableHttpStatus(generated.status)) {
          return await continueWaitingAfterTransient(item, `Notes generate temporarily unavailable (HTTP ${generated.status}).`);
        }
        await failRun(item, `Notes generation returned HTTP ${generated.status}.`, {
          external_document_id: documentId,
          generation_http_status: generated.status,
          generation_response: { queue_response: generated.body },
        });
        return { processed: true, failed: true };
      }

      await updateRows(
        "notes_auto_pipeline_items",
        {
          generation_http_status: generated.status,
          generation_response: { queue_response: generated.body },
          error_message: null,
          completed_at: null,
          updated_at: new Date().toISOString(),
        },
        { id: item.id },
      );
      scheduleNextTick();
      return { processed: true, failed: false, waiting: true, item_id: item.id };
    }

    // New topic: gather subject, chapter, topic, document, questions and PYQs, then import and generate.
    const [subjectRows, chapterRows, topicRows, docRows, questions, allocatedPyqs] = await Promise.all([
      query("SELECT id, name, slug FROM public.popular_subjects WHERE id = $1", [item.subject_id]),
      query("SELECT id, chapter_number, title FROM public.subject_chapters WHERE id = $1", [item.chapter_id]),
      query("SELECT id, topic_number, title, content_markdown, notes_markdown FROM public.subject_topics WHERE id = $1", [item.topic_id]),
      query(
        `SELECT id, display_name, source_type, source_url, status, created_at, full_content
           FROM public.ai_assistant_documents WHERE topic_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [item.topic_id],
      ),
      query(
        "SELECT id, question_text, question_format, options, correct_answer, difficulty, marks FROM public.questions WHERE topic_id = $1",
        [item.topic_id],
      ),
      query("SELECT question_text, question_format FROM public.pyq_questions WHERE topic_id = $1", [item.topic_id]).catch((e) => {
        console.warn("[notes-auto-pipeline] unable to load existing PYQ allocations", e?.message);
        return { rows: [] };
      }),
    ]);

    if (!subjectRows.rows[0]) throw new Error("Subject not found");
    if (!chapterRows.rows[0]) throw new Error("Chapter not found");
    if (!topicRows.rows[0]) throw new Error("Topic not found");

    const subject = subjectRows.rows[0];
    const chapter = chapterRows.rows[0];
    const topic = topicRows.rows[0];
    const doc = docRows.rows[0] || null;
    const questionRows = questions.rows;
    const contentMarkdown = extractContentMarkdown(doc, topic);

    const existingImportantQuestions = allocatedPyqs.rows.map((row) => ({
      question_type: row.question_format === "mcq" ? "mcq" : "normal",
      question_text: row.question_text,
    }));
    let allocation = {
      important_questions: existingImportantQuestions,
      allocated_count: existingImportantQuestions.length,
      newly_allocated_count: 0,
    };
    try {
      allocation = await invokeAllocator(pipelineSecret, {
        subject_id: item.subject_id,
        chapter_id: item.chapter_id,
        chapter_title: chapter.title,
        topic_id: item.topic_id,
        topic_title: topic.title,
        content_markdown: contentMarkdown,
        questions: questionRows.map((question) => ({ question_text: question.question_text })),
      });
    } catch (allocationError) {
      console.warn("[notes-auto-pipeline] PYQ allocation skipped; Notes generation will continue", allocationError?.message);
    }

    const parsed = doc?.full_content && typeof doc.full_content === "object" && !Array.isArray(doc.full_content) ? doc.full_content : {};
    const payload = {
      subject: { id: subject.id, name: subject.name || "", slug: subject.slug || "" },
      chapter: { id: chapter.id, chapter_number: chapter.chapter_number, title: chapter.title },
      topic: { id: topic.id, topic_number: topic.topic_number, title: topic.title },
      questions: questionRows.map((question) => ({
        id: question.id,
        question_text: question.question_text,
        question_format: toApiFormat(question.question_format),
        options: question.options || {},
        correct_answer: question.correct_answer || "",
        difficulty: toApiDifficulty(question.difficulty),
        marks: question.marks || 1,
      })),
      important_questions: Array.isArray(allocation.important_questions) ? allocation.important_questions : [],
    };
    if (doc || contentMarkdown) {
      payload.document = {
        id: doc?.id,
        display_name: doc?.display_name || `${topic.title}.md`,
        source_type: doc?.source_type || "markdown",
        source_url: doc?.source_url,
        status: doc?.status,
        created_at: doc?.created_at,
        parsed_json: { ...parsed, content_markdown: contentMarkdown },
      };
    }

    let imported;
    try {
      imported = await requestJson(`${apiBase}/documents/import-json`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isTransientNetworkError(error)) {
        return await requeueAfterTransient(item, `Document import temporarily unreachable: ${message}`, { payload });
      }
      throw error;
    }
    if (imported.status !== 200) {
      if (isRetryableHttpStatus(imported.status)) {
        return await requeueAfterTransient(item, `Document import temporarily unavailable (HTTP ${imported.status}).`, {
          payload,
          import_http_status: imported.status,
          import_response: imported.body,
        });
      }
      await failRun(item, `Document import returned HTTP ${imported.status}.`, {
        payload,
        import_http_status: imported.status,
        import_response: imported.body,
      });
      return { processed: true, failed: true };
    }

    const documentId = findDocumentId(imported.body) || String(doc?.id || "") || null;
    if (!documentId) {
      await failRun(item, "Document import returned HTTP 200 but no document ID.", {
        payload,
        import_http_status: imported.status,
        import_response: imported.body,
      });
      return { processed: true, failed: true };
    }

    let generated;
    try {
      generated = await requestJson(`${apiBase}/notes/generate/${encodeURIComponent(documentId)}`, { method: "POST" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isTransientNetworkError(error)) {
        // Import already succeeded: keep the document id and retry generate/status later.
        const now = new Date().toISOString();
        await updateRows(
          "notes_auto_pipeline_items",
          {
            status: "processing",
            payload,
            import_http_status: imported.status,
            import_response: imported.body,
            external_document_id: documentId,
            generation_http_status: null,
            generation_response: {
              queue_response: null,
              latest_status: { waiting_on_notes_api: true, transient_error: message.slice(0, 500), at: now },
            },
            error_message: null,
            completed_at: null,
            updated_at: now,
          },
          { id: item.id },
        );
        scheduleNextTick(TRANSIENT_WAIT_DELAY_MS);
        return { processed: true, waiting: true, transient: true, item_id: item.id, message };
      }
      throw error;
    }
    if (generated.status !== 200) {
      if (isRetryableHttpStatus(generated.status)) {
        const now = new Date().toISOString();
        await updateRows(
          "notes_auto_pipeline_items",
          {
            status: "processing",
            payload,
            import_http_status: imported.status,
            import_response: imported.body,
            external_document_id: documentId,
            generation_http_status: generated.status,
            generation_response: {
              queue_response: generated.body,
              latest_status: {
                waiting_on_notes_api: true,
                transient_error: `Notes generate temporarily unavailable (HTTP ${generated.status}).`,
                at: now,
              },
            },
            error_message: null,
            completed_at: null,
            updated_at: now,
          },
          { id: item.id },
        );
        scheduleNextTick(TRANSIENT_WAIT_DELAY_MS);
        return { processed: true, waiting: true, transient: true, item_id: item.id };
      }
      await failRun(item, `Notes generation returned HTTP ${generated.status}.`, {
        payload,
        import_http_status: imported.status,
        import_response: imported.body,
        external_document_id: documentId,
        generation_http_status: generated.status,
        generation_response: { queue_response: generated.body },
      });
      return { processed: true, failed: true };
    }

    await updateRows(
      "notes_auto_pipeline_items",
      {
        status: "processing",
        payload,
        import_http_status: imported.status,
        import_response: imported.body,
        external_document_id: documentId,
        generation_http_status: generated.status,
        generation_response: { queue_response: generated.body },
        error_message: null,
        completed_at: null,
        updated_at: new Date().toISOString(),
      },
      { id: item.id },
    );
    scheduleNextTick();
    return { processed: true, failed: false, waiting: true, item_id: item.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isTransientNetworkError(error) && item.external_document_id) {
      return await continueWaitingAfterTransient(item, message);
    }
    if (isTransientNetworkError(error)) return await requeueAfterTransient(item, message);
    console.error("[notes-auto-pipeline] topic failed", item.id, message);
    await failRun(item, message);
    return { processed: true, failed: true };
  }
}

router.post("/", async (req, res) => {
  try {
    const pipelineSecret = process.env.NOTES_PIPELINE_INTERNAL_SECRET || "";
    if (pipelineSecret.length < 32) throw new Error("Notes pipeline internal secret is not configured");

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const action = String(body.action || "tick");

    if (action === "tick") {
      if (!serviceKeyOk(req)) return res.status(401).json({ error: "Unauthorized" });
      return res.status(200).json(await processNext(pipelineSecret));
    }

    const userId = adminUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { rows: roleRows } = await query(
      "SELECT 1 FROM public.user_roles WHERE user_id = $1 AND role = 'admin' LIMIT 1",
      [userId],
    );
    if (!roleRows[0]) return res.status(403).json({ error: "Admin access required" });

    if (action === "pause" || action === "resume") {
      const runId = String(body.run_id || "");
      const subjectId = String(body.subject_id || "");
      if (!runId) return res.status(400).json({ error: "run_id is required" });
      if (!subjectId) return res.status(400).json({ error: "subject_id is required" });
      const now = new Date().toISOString();

      if (action === "pause") {
        const rows = await updateRows(
          "notes_auto_pipeline_runs",
          { status: "paused", updated_at: now },
          { id: runId, subject_id: subjectId, status: ["running", "paused"] },
          { returning: "id, status" },
        );
        if (!rows[0]) {
          return res.status(409).json({ error: "Could not pause pipeline. It may already be completed, failed, or stopped." });
        }
        return res.status(200).json({
          success: true,
          run_id: runId,
          status: "paused",
          message: "Pipeline paused. Current in-progress job will finish, but next jobs will not be submitted until resumed.",
        });
      }

      const rows = await updateRows(
        "notes_auto_pipeline_runs",
        { status: "running", updated_at: now },
        { id: runId, subject_id: subjectId, status: "paused" },
        { returning: "id, status" },
      );
      if (!rows[0]) return res.status(409).json({ error: "Could not resume pipeline. It must be paused first." });
      background(processNext(pipelineSecret), "resumed run failed");
      return res.status(200).json({
        success: true,
        run_id: runId,
        status: "running",
        message: "Pipeline resumed. Processing queued jobs.",
      });
    }

    if (action === "stop") {
      const runId = String(body.run_id || "");
      if (!runId) return res.status(400).json({ error: "run_id is required" });
      const now = new Date().toISOString();
      if (body.subject_id) {
        await updateRows(
          "notes_auto_pipeline_runs",
          { stop_requested: true, status: "stopped", completed_at: now, updated_at: now },
          { id: runId, subject_id: String(body.subject_id) },
        );
      }
      await updateRows(
        "notes_auto_pipeline_items",
        { status: "stopped", completed_at: now, updated_at: now },
        { run_id: runId, status: "queued" },
      );
      return res.status(200).json({ success: true, run_id: runId, status: "stopped" });
    }

    if (action !== "start") return res.status(400).json({ error: "Unknown action" });

    const subjectId = String(body.subject_id || "");
    const topicIds = Array.isArray(body.topic_ids) ? [...new Set(body.topic_ids.map(String).filter(Boolean))] : [];
    const apiBase = String(body.api_base || DEFAULT_API_BASE).replace(/\/+$/, "");
    if (!subjectId || topicIds.length === 0) {
      return res.status(400).json({ error: "subject_id and topic_ids are required" });
    }
    try {
      const parsedBase = new URL(apiBase);
      if (!/^https?:$/.test(parsedBase.protocol)) throw new Error("invalid protocol");
    } catch {
      return res.status(400).json({ error: "Invalid Notes API base URL" });
    }

    const { rows: activeRows } = await query(
      "SELECT id FROM public.notes_auto_pipeline_runs WHERE subject_id = $1 AND status = 'running' LIMIT 1",
      [subjectId],
    );
    if (activeRows[0]) {
      return res.status(409).json({ error: "This subject already has a running Notes pipeline", run_id: activeRows[0].id });
    }

    const { rows: subjectRows } = await query("SELECT id, name FROM public.popular_subjects WHERE id = $1", [subjectId]);
    if (!subjectRows[0]) throw new Error("Subject not found");
    const subject = subjectRows[0];

    const { rows: topics } = await query(
      "SELECT id, topic_number, title, chapter_id FROM public.subject_topics WHERE id = ANY($1::uuid[])",
      [topicIds],
    );
    if (topics.length !== topicIds.length) {
      return res.status(400).json({ error: "One or more selected topics are invalid" });
    }

    const chapterIds = [...new Set(topics.map((topic) => topic.chapter_id))];
    const { rows: chapters } = await query(
      "SELECT id, subject_id, chapter_number, title FROM public.subject_chapters WHERE id = ANY($1::uuid[]) AND subject_id = $2",
      [chapterIds, subjectId],
    );
    if (chapters.length !== chapterIds.length) {
      return res.status(400).json({ error: "Selected topics do not belong to this subject" });
    }
    const chapterMap = new Map(chapters.map((chapter) => [chapter.id, chapter]));

    const { rows: runRows } = await query(
      `INSERT INTO public.notes_auto_pipeline_runs
         (subject_id, subject_name, api_base, status, total_items, created_by)
       VALUES ($1, $2, $3, 'running', $4, $5)
       RETURNING *`,
      [subjectId, subject.name, apiBase, topicIds.length, userId],
    );
    const run = runRows[0];

    const topicMap = new Map(topics.map((topic) => [topic.id, topic]));
    const items = topicIds.map((topicId, index) => {
      const topic = topicMap.get(topicId);
      const chapter = chapterMap.get(topic.chapter_id);
      return {
        run_id: run.id,
        subject_id: subjectId,
        chapter_id: topic.chapter_id,
        topic_id: topic.id,
        sequence_order: index + 1,
        chapter_number: chapter.chapter_number,
        chapter_title: chapter.title,
        topic_number: topic.topic_number,
        topic_title: topic.title,
        status: "queued",
      };
    });

    try {
      const columns = [
        "run_id", "subject_id", "chapter_id", "topic_id", "sequence_order", "chapter_number",
        "chapter_title", "topic_number", "topic_title", "status",
      ];
      const params = [];
      const tuples = items.map((row) => `(${columns.map((c) => {
        params.push(row[c] ?? null);
        return `$${params.length}`;
      }).join(", ")})`);
      await query(`INSERT INTO public.notes_auto_pipeline_items (${columns.join(", ")}) VALUES ${tuples.join(", ")}`, params);
    } catch (itemsError) {
      await query("DELETE FROM public.notes_auto_pipeline_runs WHERE id = $1", [run.id]);
      throw itemsError;
    }

    background(processNext(pipelineSecret), "start run failed");
    return res.status(200).json({
      success: true,
      run_id: run.id,
      status: "running",
      total_items: items.length,
      message: `Notes pipeline started for ${items.length} topics.`,
    });
  } catch (error) {
    console.error("[notes-auto-pipeline]", error?.message);
    res.status(500).json({ error: error instanceof Error ? error.message : "Notes pipeline request failed" });
  }
});

router.use((req, res) => {
  res.status(405).json({ error: "Method not allowed" });
});
