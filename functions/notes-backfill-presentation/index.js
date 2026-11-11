// Port of supabase/functions/notes-backfill-presentation.
// Fetches presentation.json from the render server for a job, and writes it back into
// video_generation_jobs.presentation_json when the stored copy is empty or smaller.
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";

const DEFAULT_RENDER_HOST = "https://server1.simplelecture.com";
const FETCH_TIMEOUT_MS = 15_000;

export const router = express.Router();

router.all("/", async (req, res) => {
  const json = (status, body) => res.status(status).json(body);
  if (req.method === "OPTIONS") return res.status(200).send("ok");
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  // Any authenticated user may call this. The read-only fallback and the deterministic
  // backfill cannot leak data across users.
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return json(401, { error: "Unauthorized" });
  const token = authHeader.slice("Bearer ".length);
  let userId;
  try {
    userId = jwt.verify(token, process.env.JWT_SECRET).sub;
  } catch {
    return json(401, { error: "Unauthorized" });
  }
  if (!userId) return json(401, { error: "Unauthorized" });

  const body = req.body ?? {};
  const jobId = String(body?.jobId ?? "").trim();
  const externalJobId = String(body?.externalJobId ?? "").trim();
  if (!jobId || !externalJobId) return json(400, { error: "jobId and externalJobId are required" });
  if (!/^[A-Za-z0-9_-]+$/.test(externalJobId)) return json(400, { error: "externalJobId format invalid" });

  // --- Fetch presentation.json from the render server
  const renderHost = (process.env.RENDER_SERVER_URL || DEFAULT_RENDER_HOST).replace(/\/$/, "");
  const cdnUrl = `${renderHost}/video/${encodeURIComponent(externalJobId)}/presentation.json`;
  let payload;
  let bytes = 0;
  try {
    const r = await fetch(cdnUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!r.ok) {
      console.log(`[BACKFILL] cdn-http-fail jobId=${jobId} status=${r.status}`);
      return json(200, { ok: false, reason: "cdn_http_fail", status: r.status, presentation: null });
    }
    const txt = await r.text();
    bytes = txt.length;
    payload = JSON.parse(txt);
  } catch (err) {
    console.log(`[BACKFILL] cdn-fetch-err jobId=${jobId} err=${err.message}`);
    return json(200, { ok: false, reason: "cdn_fetch_err", presentation: null });
  }

  const sections = Array.isArray(payload?.sections) ? payload.sections : [];
  if (sections.length === 0) {
    console.log(`[BACKFILL] skip reason=empty-or-invalid jobId=${jobId} bytes=${bytes}`);
    return json(200, { ok: false, reason: "empty_or_invalid", presentation: null });
  }

  // --- Compare with the stored row
  let existing;
  try {
    const { rows } = await query("SELECT id, presentation_json FROM public.video_generation_jobs WHERE id = $1 LIMIT 1", [jobId]);
    existing = rows[0];
  } catch (err) {
    console.log(`[BACKFILL] db-read-err jobId=${jobId} err=${err.message}`);
    return json(200, { ok: true, wrote: false, sections: sections.length, bytes, presentation: payload });
  }
  if (!existing) {
    console.log(`[BACKFILL] db-row-missing jobId=${jobId}`);
    return json(200, { ok: true, wrote: false, sections: sections.length, bytes, presentation: payload });
  }

  const existingSections = Array.isArray(existing.presentation_json?.sections) ? existing.presentation_json.sections : [];
  let wrote = false;
  if (existingSections.length >= sections.length) {
    console.log(`[BACKFILL] skip reason=db-already-populated jobId=${jobId} dbSections=${existingSections.length} cdnSections=${sections.length}`);
  } else {
    try {
      await query(
        "UPDATE public.video_generation_jobs SET presentation_json = $1::jsonb, updated_at = now() WHERE id = $2",
        [JSON.stringify(payload), jobId]
      );
      wrote = true;
      console.log(`[BACKFILL] done jobId=${jobId} sections=${sections.length} bytes=${bytes}`);
    } catch (err) {
      console.log(`[BACKFILL] db-write-err jobId=${jobId} err=${err.message}`);
    }
  }

  return json(200, { ok: true, wrote, sections: sections.length, bytes, presentation: payload });
});

export default router;
