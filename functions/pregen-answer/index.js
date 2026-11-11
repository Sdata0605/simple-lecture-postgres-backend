// Port of supabase/functions/pregen-answer.
// Read-through cache for pre-generated AI teaching answers:
// 1. Check public.pregen_question_cache
// 2. On a miss, call the CPU teaching assistant (AI_TEACHING_CPU_BASE)
// 3. Write valid answers back to the cache
// 4. Return the answer
import express from "express";
import { query } from "../_shared/db.js";

const CPU_TIMEOUT_MS = 420_000;

export const router = express.Router();

// A cached or fresh answer is only usable when it is a real answer: not blocked, not an error,
// and it has slides.
function isValidAnswer(r) {
  return Boolean(r) && !r.blocked && !r.no_content && !r.error &&
    Array.isArray(r.presentationSlides) && r.presentationSlides.length > 0;
}

router.all("/", async (req, res) => {
  const json = (status, body) => res.status(status).json(body);
  if (req.method === "OPTIONS") return res.status(200).send("ok");
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const body = req.body ?? {};
    const questionId = body.questionId;
    const questionText = body.questionText;
    const subjectId = body.subjectId ?? null;
    const subjectName = body.subjectName;

    if (!questionId || !questionText) {
      return json(400, { error: "questionId and questionText are required" });
    }

    // 1. Cache lookup
    const { rows } = await query(
      "SELECT response_json FROM public.pregen_question_cache WHERE question_id = $1 LIMIT 1",
      [questionId]
    );
    const cached = rows[0]?.response_json;
    if (cached) {
      if (isValidAnswer(cached)) return json(200, { source: "cache", data: cached });
      console.log("[pregen-answer] ignoring stale non-answer cache row for", questionId);
    }

    // 2. CPU fetch (420 s upper bound; cached answers return in about 1 s)
    const cpuBase = process.env.AI_TEACHING_CPU_BASE;
    if (!cpuBase) return json(500, { error: "AI_TEACHING_CPU_BASE is not configured" });
    const upstream = await fetch(`${cpuBase.replace(/\/$/, "")}/ai-teaching-assistant`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": process.env.AI_TEACHING_CPU_API_KEY || "",
      },
      body: JSON.stringify({
        mode: "full",
        question: questionText,
        subjectName,
        subjectId,
        language: "en-US",
      }),
      signal: AbortSignal.timeout(CPU_TIMEOUT_MS),
    });
    const text = await upstream.text();
    const cpuData = text ? JSON.parse(text) : null;
    if (!upstream.ok) {
      return json(502, { error: cpuData?.error || `CPU HTTP ${upstream.status}` });
    }

    // 3. Write-through only for valid answers, so the cache never serves a blocked or empty reply.
    if (isValidAnswer(cpuData)) {
      try {
        await query(
          `INSERT INTO public.pregen_question_cache (question_id, subject_id, question_text, response_json, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, now())
           ON CONFLICT (question_id) DO UPDATE SET
             subject_id = EXCLUDED.subject_id,
             question_text = EXCLUDED.question_text,
             response_json = EXCLUDED.response_json,
             updated_at = EXCLUDED.updated_at`,
          [questionId, subjectId, questionText, JSON.stringify(cpuData)]
        );
      } catch (e) {
        console.warn("[pregen-answer] cache write failed (non-fatal):", e?.message);
      }
    } else {
      console.log("[pregen-answer] skipping cache write, non-answer response", {
        blocked: cpuData?.blocked, no_content: cpuData?.no_content, error: !!cpuData?.error,
      });
    }

    return json(200, { source: "cpu", data: cpuData });
  } catch (err) {
    return json(500, { error: err?.message || "Unknown error" });
  }
});

export default router;
