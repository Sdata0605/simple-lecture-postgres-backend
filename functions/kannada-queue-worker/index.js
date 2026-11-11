// Port of supabase/functions/kannada-queue-worker. A cron tick that moves Kannada avatar jobs
// through two render servers: a normal GPU server and a cloud job API. Each tick checks the job in
// flight on each server, purges queue rows already fully covered, and submits the next queued job.
// Env: KANNADA_NORMAL_SERVER_IP (the normal GPU server), KANNADA_CLOUD_SERVER_IP (the cloud job
// API). Either can be empty and that server is skipped. SERVICE_KEY is the cron key.
// Auth: header x-service-key must equal SERVICE_KEY. The render proxy is called through
// PUBLIC_BASE_URL with the same key as a Bearer token.
import express from "express";
import crypto from "node:crypto";
import { query, pool } from "../_shared/db.js";
import { userIdFromBearer, isAdminUser } from "../_shared/cdn-presentation-refresh-start-helper.js";

export const router = express.Router();

// Test hook: lets tests stub the render proxy so no real request is sent.
export const hooks = { fetch: (...args) => fetch(...args) };

const DEFAULT_SPEAKER = "abhilash";
const GRACE_MS = 5 * 60 * 1000;
const STALL_MS = 45 * 60 * 1000;

function serviceKeyOk(req) {
  const svc = process.env.SERVICE_KEY || "";
  const got = req.get("x-service-key") || "";
  return Boolean(svc) && got.length === svc.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(svc));
}

export function serverList() {
  const normal = (process.env.KANNADA_NORMAL_SERVER_IP || "").trim();
  const cloud = (process.env.KANNADA_CLOUD_SERVER_IP || "").trim();
  return { normal, cloud, servers: [normal, cloud].filter(Boolean) };
}

async function callProxy(action, payload) {
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  const key = process.env.SERVICE_KEY || "";
  const res = await hooks.fetch(`${base}/functions/v1/video-generation-proxy`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ action, ...payload }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok, status: res.status, json };
}

// The coverage scan checks auth.uid() is an admin (has_role). A cron has no user, so the scan runs
// as the admin user named in KANNADA_WORKER_ADMIN_ID, set for this transaction only.
async function coverageScan() {
  const actor = process.env.KANNADA_WORKER_ADMIN_ID;
  if (!actor) throw new Error("KANNADA_WORKER_ADMIN_ID is not configured");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: actor, role: "authenticated" })]);
    const { rows } = await client.query("SELECT * FROM public.get_kannada_coverage_scan(NULL)");
    await client.query("COMMIT");
    return rows;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Builds "UPDATE table SET ... WHERE ..." from plain objects. Values are always parameters.
async function updateRows(table, values, where) {
  const params = [];
  const sets = Object.entries(values).map(([k, v]) => {
    params.push(v);
    return `${k} = $${params.length}`;
  });
  const conds = Object.entries(where).map(([k, v]) => {
    params.push(v);
    return Array.isArray(v) ? `${k} = ANY($${params.length})` : `${k} = $${params.length}`;
  });
  const { rows } = await query(
    `UPDATE public.${table} SET ${sets.join(", ")} WHERE ${conds.join(" AND ")} RETURNING id`,
    params,
  );
  return rows;
}

// Recompute run counters from actual queue items, so two ticks cannot both add to a stale count.
async function recomputeRun(runId) {
  const { rows: runs } = await query("SELECT total FROM public.kannada_queue_runs WHERE id = $1", [runId]);
  const run = runs[0];
  if (!run) return;
  const { rows: items } = await query("SELECT status FROM public.kannada_queue_items WHERE run_id = $1", [runId]);
  const completed = items.filter((r) => r.status === "completed").length;
  const failed = items.filter((r) => r.status === "failed").length;
  const cancelled = items.filter((r) => r.status === "cancelled").length;
  const finalized = completed + failed + cancelled;
  await query(
    "UPDATE public.kannada_queue_runs SET completed = $2, failed = $3, status = $4 WHERE id = $1",
    [runId, completed, failed, finalized >= run.total ? "done" : "running"],
  );
}

async function inFlightItem(server) {
  const { rows } = await query(
    `SELECT * FROM public.kannada_queue_items WHERE server_ip = $1 AND status = 'processing' LIMIT 1`,
    [server],
  );
  return rows[0] || null;
}

// Checks one job that is already processing on a server. Pushes one result entry and returns.
async function checkInFlight(server, isCloud, inFlight, results) {
  if (!isCloud) {
    // Normal server: read live presentation.json through `review` and check Kannada per section.
    const review = await callProxy("review", { job_id: inFlight.external_job_id, server_ip: server });
    const rawSections = review.json?.sections ?? [];
    const narrationSections = rawSections.filter(
      (s) =>
        s?.narration?.full_text ||
        (s?.narration?.segments?.length ?? 0) > 0 ||
        s?.explanation_plan?.visual_beats?.some((b) => b?.segments?.length > 0),
    );
    if (review.ok && narrationSections.length > 0) {
      const allKannadaDone = narrationSections.every((s) =>
        (s.avatar_languages ?? []).some((a) => String(a.language).toLowerCase() === "kannada" && a.status === "completed"),
      );
      if (allKannadaDone) {
        await updateRows(
          "kannada_queue_items",
          { status: "completed", finished_at: new Date().toISOString(), last_error: null },
          { id: inFlight.id },
        );
        if (inFlight.run_id) await recomputeRun(inFlight.run_id);
        results.push({ server, item: inFlight.id, path: "normal", finalized: "completed_via_review", sections: narrationSections.length });
        return;
      }
      results.push({ server, item: inFlight.id, path: "normal", still_processing: true, via: "review", sections: narrationSections.length });
      return;
    }
    // Review failed: fall through to the legacy status probe.
  }

  const status = await callProxy("multilang_avatar_status", { job_id: inFlight.external_job_id, server_ip: server });

  const st = String(status.json?.state ?? status.json?.status ?? "").toLowerCase();
  const total = Number(status.json?.total ?? 0) || 0;
  const done = Number(status.json?.completed ?? 0) || 0;
  const errField = status.json?.error;
  const msg = String(errField ?? status.json?.message ?? "").toLowerCase();

  const startedAt = inFlight.started_at ? new Date(inFlight.started_at).getTime() : 0;
  const processingMs = startedAt ? Date.now() - startedAt : 0;
  const notFoundSignal = status.status === 404 || st === "not_found" || msg.includes("job not found") || msg.includes("not found");

  // Cloud only: "interrupted" means the GPU container restarted mid-job. Resubmit to resume.
  if (isCloud && st === "interrupted") {
    const resume = await callProxy("multilang_generate_avatar", {
      job_id: inFlight.external_job_id,
      languages: ["kannada"],
      speaker: DEFAULT_SPEAKER,
      server_ip: server,
      force_regenerate: false,
    });
    const resumeOk = resume.ok || String(resume.json?.status ?? "").toLowerCase() === "queued";
    await updateRows(
      "kannada_queue_items",
      {
        started_at: new Date().toISOString(),
        last_error: resumeOk
          ? "interrupted — resumed after GPU restart"
          : `interrupted — resume failed: ${JSON.stringify(resume.json).slice(0, 300)}`,
      },
      { id: inFlight.id },
    );
    results.push({ server, item: inFlight.id, resumed: resumeOk });
    return;
  }

  // 404 means different things per server. Cloud: after the grace period it is gone. Normal: wait for the stall window.
  const jobLost = isCloud && notFoundSignal && processingMs > GRACE_MS;
  const stalled = !status.ok && processingMs > STALL_MS;
  const completedByProgress = isCloud && total > 0 && done >= total;

  const terminal = st === "completed" || st === "failed" || completedByProgress || status.json?.terminal || jobLost || stalled;

  if (terminal) {
    const success = st === "completed" || completedByProgress;
    const errorMsg = success
      ? null
      : st === "failed"
        ? `avatar generation failed: ${errField || msg || "unknown error"}`
        : jobLost
          ? `job lost on cloud server (${status.status}): ${msg || st || "not found"} — FTP job expired`
          : stalled
            ? `stalled >45min with no valid status (last http ${status.status})`
            : errField || status.json?.message || `failed (${st || "unknown"})`;

    await updateRows(
      "kannada_queue_items",
      { status: success ? "completed" : "failed", finished_at: new Date().toISOString(), last_error: errorMsg },
      { id: inFlight.id },
    );
    if (inFlight.run_id) await recomputeRun(inFlight.run_id);
    results.push({
      server,
      item: inFlight.id,
      path: isCloud ? "cloud" : "normal",
      finalized: st || (jobLost ? "job_lost" : "stalled"),
    });
  } else {
    results.push({
      server,
      item: inFlight.id,
      path: isCloud ? "cloud" : "normal",
      still_processing: true,
      progress: `${done}/${total}`,
      http: status.status,
      state: st,
    });
  }
}

async function submitNext(server, fullJobIds, results) {
  const { rows: nextRows } = await query(
    `SELECT * FROM public.kannada_queue_items WHERE server_ip = $1 AND status = 'queued'
      ORDER BY enqueued_at ASC LIMIT 1`,
    [server],
  );
  const nextItem = nextRows[0];
  if (!nextItem) {
    results.push({ server, idle: true });
    return;
  }

  // Claim the row before calling the server, so two ticks cannot both submit it.
  const claimed = await updateRows(
    "kannada_queue_items",
    {
      status: "processing",
      attempts: nextItem.attempts + 1,
      started_at: new Date().toISOString(),
      last_error: "claimed — submitting to server",
    },
    { id: nextItem.id, status: "queued" },
  );
  if (!claimed.length) {
    results.push({ server, item: nextItem.id, skipped_claim_lost: true });
    return;
  }

  // If duplicate rows exist for the same job, keep one processing row (earliest) and cancel the rest.
  const { rows: dupes } = await query(
    `SELECT id FROM public.kannada_queue_items
      WHERE server_ip = $1 AND external_job_id = $2 AND status = 'processing'
      ORDER BY started_at ASC NULLS LAST, id ASC`,
    [server, nextItem.external_job_id],
  );
  const winnerId = dupes[0]?.id;
  if (winnerId && winnerId !== nextItem.id) {
    await updateRows(
      "kannada_queue_items",
      {
        status: "cancelled",
        finished_at: new Date().toISOString(),
        last_error: "duplicate suppressed — another queue row is already processing this job",
      },
      { id: nextItem.id },
    );
    if (nextItem.run_id) await recomputeRun(nextItem.run_id);
    results.push({ server, item: nextItem.id, duplicate_suppressed: true, winner: winnerId });
    return;
  }

  if (fullJobIds.has(nextItem.external_job_id)) {
    await updateRows(
      "kannada_queue_items",
      { status: "cancelled", finished_at: new Date().toISOString(), last_error: "skipped — already fully Kannada-covered" },
      { id: nextItem.id },
    );
    if (nextItem.run_id) await recomputeRun(nextItem.run_id);
    results.push({ server, item: nextItem.id, skipped_full: true });
    return;
  }

  const gen = await callProxy("multilang_generate_avatar", {
    job_id: nextItem.external_job_id,
    languages: ["kannada"],
    speaker: DEFAULT_SPEAKER,
    server_ip: server,
    force_regenerate: false,
  });

  // "already_running" (HTTP 409) is an in-flight job, not a failure.
  const rawStatus = String(gen.json?.status ?? "").toLowerCase();
  const rawMsg = String(gen.json?.message ?? gen.json?.error ?? "").toLowerCase();
  const alreadyRunning =
    gen.status === 409 || rawStatus === "already_running" || rawMsg.includes("already in progress") || rawMsg.includes("already running");

  if (!gen.ok && !alreadyRunning) {
    await updateRows(
      "kannada_queue_items",
      {
        status: "failed",
        last_error: `submit failed: ${JSON.stringify(gen.json).slice(0, 500)}`,
        finished_at: new Date().toISOString(),
      },
      { id: nextItem.id },
    );
    if (nextItem.run_id) await recomputeRun(nextItem.run_id);
    results.push({ server, item: nextItem.id, submit_failed: true });
  } else {
    await updateRows(
      "kannada_queue_items",
      {
        status: "processing",
        last_error: alreadyRunning ? "already_running (attached to in-flight job)" : null,
      },
      { id: nextItem.id },
    );
    results.push({ server, item: nextItem.id, submitted: true, attached: alreadyRunning });
  }
}

// The admin screens ("Kick worker") call this with the signed-in admin's token, so an admin is accepted too.
async function callerAllowed(req) {
  if (serviceKeyOk(req)) return true;
  const userId = userIdFromBearer(req);
  return userId ? isAdminUser(userId).catch(() => false) : false;
}

router.post("/", async (req, res) => {
  if (!(await callerAllowed(req))) return res.status(401).json({ error: "Unauthorized" });
  const results = [];
  try {
    const { servers, cloud } = serverList();
    for (const server of servers) {
      const isCloud = server === cloud;

      const { rows: countRows } = await query(
        "SELECT count(*)::int AS n FROM public.kannada_queue_items WHERE server_ip = $1 AND status = 'processing'",
        [server],
      );
      if ((countRows[0]?.n ?? 0) > 0) {
        const inFlight = await inFlightItem(server);
        if (inFlight) {
          await checkInFlight(server, isCloud, inFlight, results);
          continue;
        }
      }

      // Rows already fully Kannada-covered are cancelled so they never run.
      const coverage = await coverageScan();
      const fullJobIds = new Set(
        coverage.filter((r) => r.coverage_status === "full" && r.external_job_id).map((r) => r.external_job_id),
      );
      if (fullJobIds.size > 0) {
        const { rows: stale } = await query(
          `SELECT id, run_id FROM public.kannada_queue_items
            WHERE server_ip = $1 AND status = 'queued' AND external_job_id = ANY($2)`,
          [server, Array.from(fullJobIds)],
        );
        if (stale.length > 0) {
          await updateRows(
            "kannada_queue_items",
            {
              status: "cancelled",
              finished_at: new Date().toISOString(),
              last_error: "skipped — already fully Kannada-covered",
            },
            { id: stale.map((s) => s.id) },
          );
          const runIds = [...new Set(stale.map((s) => s.run_id).filter(Boolean))];
          for (const rid of runIds) await recomputeRun(rid);
          results.push({ server, purged_full_covered: stale.length });
        }
      }

      await submitNext(server, fullJobIds, results);
    }
    res.json({ ok: true, results });
  } catch (error) {
    console.error("kannada-queue-worker error:", error?.message);
    res.status(500).json({ ok: false, error: error?.message || "worker failed", results });
  }
});
