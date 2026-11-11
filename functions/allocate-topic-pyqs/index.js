// Port of supabase/functions/allocate-topic-pyqs. Picks previous-year questions (pyq_questions) that belong
// to one topic, using an OpenRouter classifier configured in ai_settings ('ai_api_config').
// POST { subject_id, chapter_id, topic_id, chapter_title?, topic_title?, content_markdown?, questions? }.
// Allowed callers: an admin (Bearer JWT with the admin role), or an internal caller that presents
// SERVICE_KEY as the Bearer token, or NOTES_PIPELINE_INTERNAL_SECRET (32+ chars) in x-notes-pipeline-internal.
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";

export const router = express.Router();

const jsonResponse = (res, status, body) => res.status(status).json(body);

const cleanJson = (value) => value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

function parseRelevantIds(value) {
  try {
    const parsed = JSON.parse(cleanJson(value));
    return Array.isArray(parsed?.relevant_ids) ? parsed.relevant_ids.map(String) : [];
  } catch {
    // A truncated JSON response can still contain complete UUIDs. Candidate filtering below
    // ensures that no ID outside the supplied batch can ever be allocated.
    return value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi) || [];
  }
}

const chunksOf = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const stopWords = new Set([
  "about", "after", "another", "before", "being", "between", "could", "does",
  "following", "former", "from", "have", "into", "most", "other", "their",
  "there", "these", "they", "this", "those", "using", "what", "when", "where",
  "which", "while", "with", "would",
]);

const meaningfulWords = (value) =>
  String(value || "")
    .toLowerCase()
    .match(/[a-z0-9]{4,}/g)
    ?.filter((word) => !stopWords.has(word)) || [];

const toItem = (row) => ({
  question_type: row.question_format === "mcq" ? "mcq" : "normal",
  question_text: row.question_text,
});

router.post("/", async (req, res) => {
  try {
    const serviceKey = process.env.SERVICE_KEY || "";
    const pipelineSecret = process.env.NOTES_PIPELINE_INTERNAL_SECRET || "";
    const authorization = req.headers.authorization || "";
    const bearerToken = authorization.replace(/^Bearer\s+/i, "");
    const internalToken = req.headers["x-notes-pipeline-internal"] || "";
    const isInternalRequest =
      (serviceKey && bearerToken === serviceKey) || (pipelineSecret.length >= 32 && internalToken === pipelineSecret);

    if (!isInternalRequest) {
      let userId = null;
      try {
        userId = jwt.verify(bearerToken, process.env.JWT_SECRET)?.sub || null;
      } catch {
        userId = null;
      }
      if (!userId) return jsonResponse(res, 401, { error: "Unauthorized" });
      const { rows } = await query("SELECT role FROM public.user_roles WHERE user_id = $1 AND role = 'admin' LIMIT 1", [userId]);
      if (!rows.length) return jsonResponse(res, 403, { error: "Admin access required" });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const subjectId = String(body.subject_id || "");
    const chapterId = String(body.chapter_id || "");
    const topicId = String(body.topic_id || "");
    if (!subjectId || !chapterId || !topicId) {
      return jsonResponse(res, 400, { error: "subject_id, chapter_id and topic_id are required" });
    }

    const { rows: chapterRows } = await query(
      "SELECT id, title, subject_id FROM public.subject_chapters WHERE id = $1 AND subject_id = $2 LIMIT 1",
      [chapterId, subjectId]
    );
    const { rows: topicRows } = await query(
      "SELECT id, title, chapter_id FROM public.subject_topics WHERE id = $1 AND chapter_id = $2 LIMIT 1",
      [topicId, chapterId]
    );
    const chapter = chapterRows[0];
    const topic = topicRows[0];
    if (!chapter || !topic) return jsonResponse(res, 404, { error: "Invalid subject context" });

    const { rows: pyqRows } = await query(
      `SELECT id, question_text, question_format, options, chapter_id, topic_id
         FROM public.pyq_questions WHERE subject_id = $1
        ORDER BY created_at ASC LIMIT 1000`,
      [subjectId]
    );

    const alreadyAllocated = pyqRows.filter((row) => row.topic_id === topicId);
    const candidates = pyqRows.filter((row) => !row.topic_id && (!row.chapter_id || row.chapter_id === chapterId));

    if (candidates.length === 0) {
      return jsonResponse(res, 200, {
        important_questions: alreadyAllocated.map(toItem),
        allocated_count: alreadyAllocated.length,
        newly_allocated_count: 0,
        candidates_checked: 0,
      });
    }

    const { rows: configRows } = await query("SELECT setting_value FROM public.ai_settings WHERE setting_key = $1 LIMIT 1", ["ai_api_config"]);
    const config = configRows[0]?.setting_value || null;
    if (!config?.enabled || config.provider !== "openrouter" || typeof config.openrouter_api_key !== "string" || !config.openrouter_api_key) {
      return jsonResponse(res, 200, {
        important_questions: alreadyAllocated.map(toItem),
        allocated_count: alreadyAllocated.length,
        newly_allocated_count: 0,
        candidates_checked: candidates.length,
        warnings: ["The admin OpenRouter configuration is unavailable; existing allocations were used."],
      });
    }

    const topicContext = {
      chapter: String(body.chapter_title || chapter.title || "").slice(0, 500),
      topic: String(body.topic_title || topic.title || "").slice(0, 500),
      parsed_content: String(body.content_markdown || "").slice(0, 12000),
      normal_questions: Array.isArray(body.questions)
        ? body.questions.slice(0, 100).map((question) =>
            typeof question === "string" ? question.slice(0, 500) : String(question?.question_text || "").slice(0, 500)
          )
        : [],
    };

    const contextWords = new Set(
      meaningfulWords([topicContext.topic, topicContext.parsed_content, ...topicContext.normal_questions].join(" "))
    );
    const contextCandidates = candidates.filter((row) => {
      const optionText = row.options ? JSON.stringify(row.options) : "";
      const matches = new Set(meaningfulWords(`${row.question_text} ${optionText}`).filter((w) => contextWords.has(w)));
      return matches.size >= 2;
    });

    if (contextCandidates.length === 0) {
      return jsonResponse(res, 200, {
        important_questions: alreadyAllocated.map(toItem),
        allocated_count: alreadyAllocated.length,
        newly_allocated_count: 0,
        candidates_checked: candidates.length,
      });
    }

    const model = typeof config.default_model === "string" && config.default_model ? config.default_model : "google/gemini-2.5-flash";

    const classifyBatch = async (batch) => {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.openrouter_api_key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "You allocate previous-year exam questions to one exact textbook topic. " +
                "Select a question only when its answer is explicitly and directly supported by the " +
                "supplied parsed content or normal questions. Do not select questions about a related " +
                "cause, consequence, person, date, or event that is only mentioned in passing. Do not " +
                "select broad chapter-level themes, definitions, or outcomes unless this exact topic teaches " +
                "them. Do not select merely because it belongs to the same subject or chapter. When uncertain, omit it. " +
                'Return strict JSON only: {"relevant_ids":["uuid"]}.',
            },
            {
              role: "user",
              content: JSON.stringify({
                topic_context: topicContext,
                candidate_questions: batch.map((row) => ({
                  id: row.id,
                  question_text: row.question_text,
                  question_format: row.question_format,
                  options: row.options,
                })),
              }),
            },
          ],
        }),
      });
      if (!response.ok) {
        const details = await response.text();
        throw new Error(`OpenRouter classification failed (${response.status}): ${details.slice(0, 300)}`);
      }
      const result = await response.json();
      return parseRelevantIds(String(result.choices?.[0]?.message?.content || ""));
    };

    const batches = chunksOf(contextCandidates, 60);
    const classificationResults = await Promise.allSettled(batches.map(classifyBatch));
    const classifiedIds = classificationResults.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    const warnings = classificationResults.flatMap((r, index) =>
      r.status === "rejected"
        ? [`PYQ classification batch ${index + 1} was skipped: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`]
        : []
    );
    const candidateIds = new Set(contextCandidates.map((row) => row.id));
    const relevantIds = [...new Set(classifiedIds)].filter((id) => candidateIds.has(id));

    for (const idBatch of chunksOf(relevantIds, 100)) {
      await query(
        "UPDATE public.pyq_questions SET chapter_id = $1, topic_id = $2 WHERE id = ANY($3::uuid[]) AND topic_id IS NULL",
        [chapterId, topicId, idBatch]
      );
    }

    const relevantSet = new Set(relevantIds);
    const newlyAllocated = candidates.filter((row) => relevantSet.has(row.id));
    const allRelevant = [...alreadyAllocated, ...newlyAllocated];

    return jsonResponse(res, 200, {
      important_questions: allRelevant.map(toItem),
      allocated_count: allRelevant.length,
      newly_allocated_count: newlyAllocated.length,
      candidates_checked: candidates.length,
      model,
      warnings,
    });
  } catch (error) {
    console.error("[allocate-topic-pyqs]", error?.message);
    return jsonResponse(res, 500, { error: error instanceof Error ? error.message : "Unable to allocate PYQ questions" });
  }
});
