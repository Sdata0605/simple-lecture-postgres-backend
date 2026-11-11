// Port of supabase/functions/deduplicate-questions. Admin-only. Removes questions whose text (case-
// and whitespace-insensitive) repeats within the same topic and chapter, keeping the oldest.
// Scope: topicId, else chapterId, else subjectId; with no scope, the whole question bank is checked.
// POST { subjectId, chapterId, topicId }.
//
// Fix from the original: when a chapter or subject has no topics, the original fell back to checking
// every question in the bank. Now that scope gives no questions, so nothing outside it is deleted.
import express from "express";
import { query } from "../_shared/db.js";
import { userIdFromBearer, isAdminUser } from "../_shared/cdn-presentation-refresh-start-helper.js";

export const router = express.Router();

const sendJson = (res, status, body) => res.status(status).type("application/json").send(JSON.stringify(body));

// Topic ids in scope, or null when no scope was given.
async function scopeTopicIds({ subjectId, chapterId, topicId }) {
  if (topicId) return [topicId];
  if (chapterId) {
    const { rows } = await query("SELECT id FROM public.subject_topics WHERE chapter_id = $1", [chapterId]);
    return rows.map((t) => t.id);
  }
  if (subjectId) {
    const { rows: chapters } = await query("SELECT id FROM public.subject_chapters WHERE subject_id = $1", [subjectId]);
    if (chapters.length === 0) return [];
    const { rows: topics } = await query("SELECT id FROM public.subject_topics WHERE chapter_id = ANY($1::uuid[])", [
      chapters.map((c) => c.id),
    ]);
    return topics.map((t) => t.id);
  }
  return null;
}

router.post("/", async (req, res) => {
  const userId = userIdFromBearer(req);
  if (!userId) return sendJson(res, 401, { error: "Unauthorized" });
  if (!(await isAdminUser(userId))) return sendJson(res, 403, { error: "Forbidden" });

  const body = req.body || {};
  try {
    const topicIds = await scopeTopicIds(body);
    const scoped = topicIds !== null;

    let questions;
    if (scoped && topicIds.length === 0) {
      questions = [];
    } else {
      const params = [];
      let where = "";
      if (scoped) {
        params.push(topicIds);
        where = "WHERE topic_id = ANY($1::uuid[])";
      }
      ({ rows: questions } = await query(
        `SELECT id, question_text, chapter_id, topic_id, created_at FROM public.questions ${where} ORDER BY created_at ASC`,
        params
      ));
    }

    if (questions.length === 0) {
      return sendJson(res, 200, { success: true, duplicatesRemoved: 0, message: "No questions found to deduplicate" });
    }

    // Same text within the same topic and chapter counts as a duplicate. The first one is kept.
    const seen = new Set();
    const duplicateIds = [];
    for (const q of questions) {
      const normalized = String(q.question_text || "").toLowerCase().trim().replace(/\s+/g, " ");
      const key = `${normalized}|${q.topic_id || ""}|${q.chapter_id || ""}`;
      if (seen.has(key)) duplicateIds.push(q.id);
      else seen.add(key);
    }

    if (duplicateIds.length === 0) {
      return sendJson(res, 200, { success: true, duplicatesRemoved: 0, message: "No duplicates found" });
    }

    const batchSize = 100;
    let totalDeleted = 0;
    for (let i = 0; i < duplicateIds.length; i += batchSize) {
      const batch = duplicateIds.slice(i, i + batchSize);
      await query("DELETE FROM public.questions WHERE id = ANY($1::uuid[])", [batch]);
      totalDeleted += batch.length;
    }

    return sendJson(res, 200, {
      success: true,
      duplicatesRemoved: totalDeleted,
      message: `Removed ${totalDeleted} duplicate questions`,
    });
  } catch (error) {
    console.error("Error in deduplicate-questions:", error.message);
    return sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Unknown error",
      duplicatesRemoved: 0,
    });
  }
});
