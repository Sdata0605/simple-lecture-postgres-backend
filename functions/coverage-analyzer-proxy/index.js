// Port of supabase/functions/coverage-analyzer-proxy. Admin-only proxy to the coverage analyser.
// Any path after /coverage-analyzer-proxy is forwarded to COVERAGE_ANALYZER_BASE_URL. The run
// start and terminal poll results are saved to public.coverage_analyzer_reports.
import express from "express";
import { query } from "../_shared/db.js";
import { userIdFromBearer, isAdminUser } from "../_shared/cdn-presentation-refresh-start-helper.js";

export const router = express.Router();
export const hooks = { fetch: null };

const sendJson = (res, status, body) => res.status(status).type("application/json").send(JSON.stringify(body));

router.use(express.json({ limit: "1mb" }), async (req, res) => {
  const auth = String(req.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) return sendJson(res, 401, { error: "Unauthorized" });
  const userId = userIdFromBearer(req);
  if (!userId) return sendJson(res, 401, { error: "Unauthorized" });
  if (!(await isAdminUser(userId))) return sendJson(res, 403, { error: "Forbidden" });

  const base = process.env.COVERAGE_ANALYZER_BASE_URL;
  if (!base) return sendJson(res, 500, { error: "COVERAGE_ANALYZER_BASE_URL is not configured" });

  try {
    let forwardPath = req.path || "";
    if (!forwardPath.startsWith("/")) forwardPath = "/" + forwardPath;
    if (forwardPath === "/") forwardPath = "/api/health";

    const search = req.originalUrl.includes("?") ? "?" + req.originalUrl.split("?").slice(1).join("?") : "";
    const targetUrl = base.replace(/\/$/, "") + forwardPath + search;

    const method = req.method.toUpperCase();
    const hasBody = method === "POST" || method === "PUT" || method === "PATCH";
    const bodyPayload = hasBody && req.body && typeof req.body === "object" && Object.keys(req.body).length ? req.body : null;
    const init = { method, headers: { "Content-Type": "application/json" } };
    if (bodyPayload) init.body = JSON.stringify(bodyPayload);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    init.signal = controller.signal;

    let upstream;
    let upstreamText;
    try {
      upstream = await (hooks.fetch ?? fetch)(targetUrl, init);
      upstreamText = await upstream.text();
    } finally {
      clearTimeout(timer);
    }
    let upstreamJson = null;
    try {
      upstreamJson = upstreamText ? JSON.parse(upstreamText) : null;
    } catch {
      // not JSON: forwarded as-is
    }

    try {
      // Starting a run: POST /api/analyze stores the initial row.
      if (method === "POST" && forwardPath === "/api/analyze" && upstreamJson?.run_id) {
        await query(
          `INSERT INTO public.coverage_analyzer_reports
             (run_id, subject_prefix, publish_action, job_id, status, report, started_at, created_by)
           VALUES ($1, $2, $3, $4, 'started', $5::jsonb, now(), $6)`,
          [
            upstreamJson.run_id,
            bodyPayload?.type ?? null,
            bodyPayload?.action ?? "analyze",
            Array.isArray(bodyPayload?.job_ids) ? bodyPayload.job_ids.join(",") : null,
            JSON.stringify(upstreamJson),
            userId,
          ]
        );
      }

      // Poll: GET /api/analyze/:runId stores the final row on a terminal status.
      if (method === "GET" && forwardPath.startsWith("/api/analyze/") && upstreamJson?.status) {
        const runId = forwardPath.split("/api/analyze/")[1];
        const status = String(upstreamJson.status);
        if (["done", "failed", "error", "completed"].includes(status) && runId) {
          const results = Array.isArray(upstreamJson.results) ? upstreamJson.results : [];
          const first = results[0]?.coverage ?? {};
          await query(
            `UPDATE public.coverage_analyzer_reports
                SET status = $1,
                    coverage_percent = $2,
                    topics_missing = $3::jsonb,
                    log = $4::jsonb,
                    report = $5::jsonb,
                    job_id = $6,
                    finished_at = $7,
                    started_at = $8
              WHERE run_id = $9`,
            [
              status,
              first?.coverage_percent ?? null,
              first?.topics_missing == null ? null : JSON.stringify(first.topics_missing),
              upstreamJson.log == null ? null : JSON.stringify(upstreamJson.log),
              JSON.stringify(upstreamJson),
              Array.isArray(upstreamJson.jobs) ? upstreamJson.jobs.join(",") : null,
              upstreamJson.finished_at ?? new Date().toISOString(),
              upstreamJson.started_at ?? null,
              runId,
            ]
          );
        }
      }
    } catch (e) {
      console.error("coverage persist error", e.message);
    }

    return res.status(upstream.status).type("application/json").send(upstreamText || "{}");
  } catch (e) {
    console.error("coverage proxy error", e.message);
    return sendJson(res, 500, { error: String(e?.message || e) });
  }
});
