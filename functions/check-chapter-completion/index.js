// Port of supabase/functions/check-chapter-completion. When every published lecture in a chapter has
// been watched by the signed-in student, creates the chapter test (through create-self-test, with
// the same token) and records it in auto_chapter_tests. The call is idempotent per student+chapter.
// POST { chapterId, courseId, subjectId }.
import express from "express";
import { query } from "../_shared/db.js";
import { userIdFromBearer } from "../_shared/cdn-presentation-refresh-start-helper.js";

export const router = express.Router();
export const hooks = { fetch: null };

const sendJson = (res, status, body) => res.status(status).type("application/json").send(JSON.stringify(body));

// Base URL of this server, from PUBLIC_BASE_URL (same rule as the storage helper).
const publicBase = () =>
  (process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${process.env.PORT || 8787}`).replace(/\/$/, "");

router.post("/", async (req, res) => {
  const authHeader = String(req.headers.authorization || "");
  const userId = userIdFromBearer(req);
  if (!userId) return sendJson(res, 401, { error: "Not authenticated" });

  try {
    const { chapterId, courseId, subjectId } = req.body || {};
    if (!chapterId || !courseId || !subjectId) {
      return sendJson(res, 400, { error: "Missing chapterId / courseId / subjectId" });
    }

    // 1) Already triggered for this chapter.
    const { rows: existingRows } = await query(
      "SELECT id, self_test_id, chapter_title, status FROM public.auto_chapter_tests WHERE student_id = $1 AND chapter_id = $2 LIMIT 1",
      [userId, chapterId]
    );
    const existing = existingRows[0];
    if (existing) {
      return sendJson(res, 200, {
        completed: true,
        alreadyExisted: true,
        selfTestId: existing.self_test_id,
        chapterTitle: existing.chapter_title,
        status: existing.status,
      });
    }

    // 2) Chapter and its topics.
    let chapter;
    try {
      const { rows } = await query("SELECT id, title FROM public.subject_chapters WHERE id = $1", [chapterId]);
      chapter = rows[0];
    } catch {
      chapter = undefined;
    }
    if (!chapter) return sendJson(res, 404, { error: "Chapter not found" });

    const { rows: topics } = await query("SELECT id, title FROM public.subject_topics WHERE chapter_id = $1", [chapterId]);
    if (topics.length === 0) return sendJson(res, 200, { completed: false, reason: "no_topics" });
    const topicIds = topics.map((t) => t.id);

    // 3) Topics with at least one published, completed lecture. Only these must be watched.
    const { rows: publishedDocs } = await query(
      `SELECT d.topic_id
         FROM public.ai_assistant_documents d
         JOIN public.video_generation_jobs v ON v.document_id = d.id
        WHERE d.topic_id = ANY($1::uuid[]) AND v.is_published = true AND v.status = 'completed'`,
      [topicIds]
    );
    const requiredTopicIds = [];
    for (const d of publishedDocs) {
      if (d.topic_id && !requiredTopicIds.includes(d.topic_id)) requiredTopicIds.push(d.topic_id);
    }
    if (requiredTopicIds.length === 0) {
      return sendJson(res, 200, { completed: false, reason: "no_published_lectures" });
    }

    // 4) Watch logs for those topics.
    const { rows: watchLogs } = await query(
      "SELECT topic_id FROM public.ai_video_watch_logs WHERE student_id = $1 AND topic_id = ANY($2::uuid[])",
      [userId, requiredTopicIds]
    );
    const watched = new Set(watchLogs.map((w) => w.topic_id).filter(Boolean));

    // 5) Every required topic must be watched.
    for (const tid of requiredTopicIds) {
      if (!watched.has(tid)) {
        return sendJson(res, 200, { completed: false, reason: "topic_not_watched", topicId: tid });
      }
    }

    // 6) Create the chapter test through create-self-test, with the student's own token.
    const title = `Chapter Test – ${chapter.title}`;
    const csRes = await (hooks.fetch ?? fetch)(`${publicBase()}/functions/v1/create-self-test`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader },
      body: JSON.stringify({
        courseId,
        subjectId,
        testType: "chapter",
        chapterIds: [chapterId],
        topicIds: [],
        title,
        scheduledAt: new Date().toISOString(),
        durationMinutes: 180,
      }),
    });
    const csJson = await csRes.json().catch(() => ({}));
    if (!csRes.ok || !csJson?.id) {
      return sendJson(res, 500, { completed: false, reason: "create_self_test_failed", detail: csJson });
    }

    // 7) Record it. (student_id, chapter_id) is unique, so repeats are safe.
    let bound = null;
    try {
      const { rows } = await query(
        `INSERT INTO public.auto_chapter_tests
           (student_id, course_id, subject_id, chapter_id, chapter_title, self_test_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')
         ON CONFLICT (student_id, chapter_id) DO UPDATE
           SET course_id = EXCLUDED.course_id,
               subject_id = EXCLUDED.subject_id,
               chapter_title = EXCLUDED.chapter_title,
               self_test_id = EXCLUDED.self_test_id,
               status = EXCLUDED.status
         RETURNING self_test_id, chapter_title`,
        [userId, courseId, subjectId, chapterId, chapter.title, csJson.id]
      );
      bound = rows[0];
    } catch (e) {
      console.error("[check-chapter-completion] bind error", e.message);
    }

    return sendJson(res, 200, {
      completed: true,
      alreadyExisted: false,
      selfTestId: bound?.self_test_id || csJson.id,
      chapterTitle: bound?.chapter_title || chapter.title,
    });
  } catch (e) {
    console.error("[check-chapter-completion]", e.message);
    return sendJson(res, 500, { error: e?.message || String(e) });
  }
});
