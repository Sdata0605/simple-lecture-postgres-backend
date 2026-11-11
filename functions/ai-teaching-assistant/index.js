// Port of supabase/functions/ai-teaching-assistant. Thin proxy to the external AI Teaching Assistant API.
// The upstream URL is AI_TEACHING_ASSISTANT_URL and its key is AI_TEACHING_ASSISTANT_API_KEY, both from env.
// POST body fields are mapped to the upstream contract (mode, question, subjectName, subjectId, language, userTier).
//
// Upstream 200 bodies are passed through unchanged (they may carry an "error" or "blocked" field that the
// frontend interprets). Only transport failures, HTTP 5xx, and HTTP 429 are retried, within one overall deadline.
//
// Async jobs: POST /jobs returns 202 {jobId} and runs the same logic in the background; GET /jobs/:jobId polls it.
// Jobs live in memory and are removed 15 minutes after they finish.
import express from "express";
import { randomUUID } from "node:crypto";

export const router = express.Router();

const MAX_ATTEMPTS = 3;
const DEFAULT_DEADLINE_MS = 420_000;
const JOB_TTL_MS = 15 * 60 * 1000;

const FRIENDLY = {
  not_configured: {
    status: 500,
    retryable: false,
    message: "The AI tutor is not set up on the server yet. Please contact support.",
  },
  invalid_request: { status: 400, retryable: false, message: "Please type a question first." },
  bad_request: { status: 400, retryable: false, message: "We could not send your question. Please try again." },
  unavailable: {
    status: 503,
    retryable: true,
    message: "The AI tutor is busy right now. Please try again in a minute.",
  },
  rate_limited: {
    status: 429,
    retryable: true,
    message: "Too many questions right now. Please wait a moment and try again.",
  },
  timeout: { status: 504, retryable: true, message: "The AI tutor took too long to answer. Please ask again." },
  network: {
    status: 502,
    retryable: true,
    message: "We could not reach the AI tutor. Check your connection and try again.",
  },
  job_not_found: { status: 404, retryable: false, message: "This request has expired. Please ask again." },
};

// Failure kinds produced by a single attempt, mapped to the friendly error code.
const KIND_TO_CODE = {
  timeout: "timeout",
  network: "network",
  rate: "rate_limited",
  server: "unavailable",
  client: "bad_request",
};
const RETRYABLE_KINDS = new Set(["timeout", "network", "rate", "server"]);

function friendly(code) {
  return { code, message: FRIENDLY[code].message, retryable: FRIENDLY[code].retryable };
}

function sendError(res, code) {
  return res.status(FRIENDLY[code].status).json({ error: friendly(code) });
}

function deadlineMs() {
  const v = Number(process.env.AI_TEACHING_DEADLINE_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_DEADLINE_MS;
}

// Maps the client body onto the upstream contract. Returns { error } or { upstreamBody }.
function prepare(rawBody) {
  const body = rawBody && typeof rawBody === "object" ? rawBody : {};
  const mode = body.mode || "full";

  const upstreamBody = {
    mode,
    question: body.question ?? body.questionText ?? "",
    subjectName: body.subjectName ?? undefined,
    subjectId: body.subjectId ?? body.topicId ?? body.chapterId ?? undefined,
    language: body.language || "en-US",
    userTier: body.userTier || "pro",
  };
  if (mode === "doubt") {
    upstreamBody.questionText = body.questionText;
    upstreamBody.correctAnswer = body.correctAnswer;
    upstreamBody.studentAnswer = body.studentAnswer;
  }

  if (typeof upstreamBody.question !== "string" || upstreamBody.question.trim() === "") {
    return { error: "invalid_request" };
  }
  return { upstreamBody };
}

// One HTTP attempt. The per-attempt timeout is the time left until the overall deadline.
async function attemptOnce(url, key, upstreamBody, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": key },
      body: JSON.stringify(upstreamBody),
      signal: controller.signal,
    });
    const text = await upstream.text();
    if (upstream.ok) return { ok: true, text };
    const kind = upstream.status === 429 ? "rate" : upstream.status >= 500 ? "server" : "client";
    return { ok: false, kind, status: upstream.status, detail: text };
  } catch (err) {
    if (timedOut) return { ok: false, kind: "timeout", detail: "per-attempt deadline reached" };
    return { ok: false, kind: "network", detail: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// Runs the upstream call with retries under one overall deadline.
// Returns { ok: true, text } or { ok: false, code } where code is a FRIENDLY key.
// report(stage, attempt) is called at each stage transition.
async function runTutor(upstreamBody, report = () => {}) {
  report("validating", 0);
  const url = process.env.AI_TEACHING_ASSISTANT_URL;
  if (!url) {
    console.warn("[ai-teaching-assistant] AI_TEACHING_ASSISTANT_URL is not set");
    return { ok: false, code: "not_configured" };
  }
  const key = process.env.AI_TEACHING_ASSISTANT_API_KEY || "";
  const deadlineAt = Date.now() + deadlineMs();
  let last = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    report("contacting", attempt);
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      last = { kind: "timeout", detail: "overall deadline reached" };
      break;
    }

    report("waiting", attempt);
    const out = await attemptOnce(url, key, upstreamBody, remaining);
    if (out.ok) {
      report("received", attempt);
      return out;
    }

    last = out;
    const statusPart = out.status ? ` ${out.status}` : "";
    console.warn(
      `[ai-teaching-assistant] attempt ${attempt}/${MAX_ATTEMPTS} failed (${out.kind}${statusPart}): ${String(out.detail ?? "").slice(0, 300)}`,
    );

    if (!RETRYABLE_KINDS.has(out.kind) || attempt === MAX_ATTEMPTS) break;
    const backoff = attempt * 1000;
    if (Date.now() + backoff >= deadlineAt) break;
    report("retrying", attempt);
    await new Promise((r) => setTimeout(r, backoff));
  }

  return { ok: false, code: KIND_TO_CODE[last.kind] };
}

router.post("/", async (req, res) => {
  try {
    const prepared = prepare(req.body);
    if (prepared.error) return sendError(res, prepared.error);

    const out = await runTutor(prepared.upstreamBody);
    if (out.ok) return res.status(200).set("Content-Type", "application/json").send(out.text);
    return sendError(res, out.code);
  } catch (err) {
    console.error("[ai-teaching-assistant] handler error:", err?.message);
    return sendError(res, "unavailable");
  }
});

// ---- Async jobs (in memory) ----

export const _jobs = new Map();

export function _resetJobs() {
  for (const job of _jobs.values()) clearTimeout(job.timer);
  _jobs.clear();
}

function sweepJobs() {
  const now = Date.now();
  for (const [id, job] of _jobs) {
    if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) {
      clearTimeout(job.timer);
      _jobs.delete(id);
    }
  }
}

function createJob() {
  sweepJobs();
  const job = {
    jobId: randomUUID(),
    stage: "validating",
    attempt: 0,
    startedAt: Date.now(),
    finishedAt: null,
    result: null,
    error: null,
    timer: null,
  };
  _jobs.set(job.jobId, job);
  return job;
}

function finishJob(job, stage) {
  job.stage = stage;
  job.finishedAt = Date.now();
  job.timer = setTimeout(() => _jobs.delete(job.jobId), JOB_TTL_MS);
  job.timer.unref?.();
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function runJob(job, upstreamBody) {
  try {
    const out = await runTutor(upstreamBody, (stage, attempt) => {
      job.stage = stage;
      if (attempt) job.attempt = attempt;
    });
    if (out.ok) {
      job.result = parseJson(out.text);
      finishJob(job, "done");
    } else {
      job.error = friendly(out.code);
      finishJob(job, "failed");
    }
  } catch (err) {
    console.error("[ai-teaching-assistant] job error:", err?.message);
    job.error = friendly("unavailable");
    finishJob(job, "failed");
  }
}

router.post("/jobs", (req, res) => {
  const prepared = prepare(req.body);
  if (prepared.error) return sendError(res, prepared.error);

  const job = createJob();
  res.status(202).json({ jobId: job.jobId });
  void runJob(job, prepared.upstreamBody);
});

router.get("/jobs/:jobId", (req, res) => {
  sweepJobs();
  const job = _jobs.get(req.params.jobId);
  if (!job) return sendError(res, "job_not_found");

  const end = job.finishedAt ?? Date.now();
  const payload = {
    jobId: job.jobId,
    stage: job.stage,
    attempt: job.attempt,
    maxAttempts: MAX_ATTEMPTS,
    elapsedSec: Math.floor((end - job.startedAt) / 1000),
    startedAt: new Date(job.startedAt).toISOString(),
    finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
  };
  if (job.stage === "done") payload.result = job.result;
  if (job.stage === "failed") payload.error = job.error;
  return res.json(payload);
});
