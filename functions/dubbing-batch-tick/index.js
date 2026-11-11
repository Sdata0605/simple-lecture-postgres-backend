// Port of supabase/functions/dubbing-batch-tick. Server-side runner for the admin "Auto Pipeline"
// of dubbing batches (auto_submission_runs with kind 'dubbing_batch'). It was run every minute by
// pg_cron. Here a scheduler calls it with header x-cron-key = DUBBING_TICK_CRON_KEY (fails closed).
// Each tick claims the run atomically (claim_auto_submission_run), then submits or polls one item.
// Calls to the video generation proxy go to PUBLIC_BASE_URL with header x-service-key =
// INTERNAL_SERVICE_KEY.
import express from "express";
import { query } from "../_shared/db.js";
import { cronKeyOk, serviceKeyOk } from "../_shared/cdn-presentation-refresh-start-helper.js";

export const router = express.Router();
export const hooks = { fetch: null };

const sendJson = (res, status, body) => res.status(status).type("application/json").send(JSON.stringify(body));

const publicBase = () =>
  (process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${process.env.PORT || 8787}`).replace(/\/$/, "");

// Calls the video generation proxy as the service. Returns { ok, data }.
async function callProxy(body) {
  const resp = await (hooks.fetch ?? fetch)(`${publicBase()}/functions/v1/video-generation-proxy`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-service-key": process.env.INTERNAL_SERVICE_KEY || "",
    },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => null);
  return { ok: resp.ok, data };
}

const PATCHABLE = new Set(["items", "status", "current_index"]);

async function saveRun(runId, patch) {
  const sets = [];
  const params = [];
  for (const [col, val] of Object.entries(patch)) {
    if (!PATCHABLE.has(col)) continue;
    params.push(col === "items" ? JSON.stringify(val) : val);
    sets.push(`${col} = $${params.length}${col === "items" ? "::jsonb" : ""}`);
  }
  sets.push("last_tick_at = now()");
  params.push(runId);
  await query(`UPDATE public.auto_submission_runs SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
}

async function processRun(run) {
  // Atomic claim: stops a concurrent tick from submitting the same item twice.
  const { rows: claimRows } = await query("SELECT public.claim_auto_submission_run($1, $2) AS claimed", [run.id, 25]);
  if (claimRows[0]?.claimed !== true) return;

  const items = Array.isArray(run.items) ? run.items : [];
  const idx = run.current_index ?? 0;
  if (idx >= items.length) {
    await saveRun(run.id, { status: "completed" });
    return;
  }
  const item = items[idx];
  const setItem = (patch) => {
    items[idx] = { ...items[idx], ...patch };
  };

  const cfg = run.pipeline_config && typeof run.pipeline_config === "object" ? run.pipeline_config : {};
  const languages = Array.isArray(cfg.languages) ? cfg.languages : [];

  // QUEUED: start dubbing for this item's video job.
  if (item.status === "queued") {
    try {
      const { ok, data } = await callProxy({
        action: "dub_languages",
        job_id: item.externalJobId,
        server_ip: item.serverIp,
        languages,
        speaker: cfg.speaker || "abhilash",
        tts_engine: cfg.tts_engine || "edgetts",
        ...(cfg.avatar_id ? { avatar_id: cfg.avatar_id } : {}),
        skip_avatar: !!cfg.skip_avatar,
        skip_section_merge: !!cfg.skip_section_merge,
        skip_final_merge: !!cfg.skip_final_merge,
      });
      const status = data?.status;
      if (!ok || (status && status !== "queued")) {
        throw new Error(data?.message || data?.error || "dub_languages request failed");
      }
      setItem({ status: "processing", progressMessage: "Dubbing started..." });
      await saveRun(run.id, { items });
    } catch (e) {
      setItem({ status: "stopped", errorMessage: `Submit failed: ${String(e.message || e)}` });
      await saveRun(run.id, { items, status: "stopped" });
    }
    return;
  }

  // PROCESSING: poll dub_status.
  if (item.status === "processing") {
    const { ok, data } = await callProxy({
      action: "dub_status",
      job_id: item.externalJobId,
      server_ip: item.serverIp,
    });
    if (!ok || !data) {
      await saveRun(run.id, { items });
      return;
    }
    const details = data.details;
    const status = data.status;
    setItem({ progressMessage: details?.progress || item.progressMessage });

    if (status === "completed") {
      const { data: reviewData } = await callProxy({
        action: "review",
        job_id: item.externalJobId,
        server_ip: item.serverIp,
      });
      const dubbed = Array.isArray(reviewData?.dubbed_languages) ? reviewData.dubbed_languages : [];
      setItem({ status: "completed", dubbedLanguages: dubbed, progressMessage: "Dubbing complete" });
      const nextIdx = idx + 1;
      await saveRun(run.id, {
        items,
        current_index: nextIdx,
        status: nextIdx >= items.length ? "completed" : "running",
      });
      return;
    }

    if (status === "failed") {
      setItem({ status: "stopped", errorMessage: details?.error || "Dubbing failed" });
      await saveRun(run.id, { items, status: "stopped" });
      return;
    }

    // Still running: save progress and wait for the next tick.
    await saveRun(run.id, { items });
    return;
  }

  // Completed item at current_index: advance.
  if (item.status === "completed") {
    const nextIdx = idx + 1;
    await saveRun(run.id, {
      current_index: nextIdx,
      status: nextIdx >= items.length ? "completed" : "running",
    });
  }
}

router.post("/", async (req, res) => {
  if (!cronKeyOk(req, "DUBBING_TICK_CRON_KEY") && !serviceKeyOk(req)) {
    return sendJson(res, 401, { error: "Unauthorized" });
  }
  try {
    const { rows: runs } = await query(
      "SELECT * FROM public.auto_submission_runs WHERE status = 'running' AND kind = 'dubbing_batch'"
    );
    await Promise.all(
      runs.map((r) =>
        processRun(r).catch((e) => {
          console.error("[dubbing-batch-tick] run", r.id, e.message);
        })
      )
    );
    return sendJson(res, 200, { processed: runs.length });
  } catch (e) {
    console.error("[dubbing-batch-tick] error", e.message);
    return sendJson(res, 500, { error: String(e.message || e) });
  }
});
