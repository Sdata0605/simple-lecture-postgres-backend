// Port of supabase/functions/award-badge. Awards topic, chapter, subject, and course badges to the
// signed-in student, checking what they have already completed.
// POST { topicId?, chapterId?, subjectId?, courseId?, topicTitle? } with a Bearer token.
// Each insert failure is logged and skipped, as in the original.
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";

export const router = express.Router();

const TAG = "[award-badge]";
const FILTER_COLUMNS = ["topic_id", "chapter_id", "subject_id", "course_id"];

async function badgeExists(studentId, badgeType, filters) {
  const params = [studentId, badgeType];
  let sql = "SELECT id FROM public.student_badges WHERE student_id = $1 AND badge_type = $2";
  for (const [key, value] of Object.entries(filters)) {
    if (!FILTER_COLUMNS.includes(key)) throw new Error("bad filter");
    if (value) {
      params.push(value);
      sql += ` AND ${key} = $${params.length}`;
    }
  }
  const { rows } = await query(sql + " LIMIT 1", params);
  return rows.length > 0;
}

// Inserts a badge. Returns true when it was written. A failed insert is logged and returns false.
async function insertBadge(label, row) {
  try {
    await query(
      `INSERT INTO public.student_badges
         (student_id, badge_type, topic_id, chapter_id, subject_id, course_id, title, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        row.student_id,
        row.badge_type,
        row.topic_id ?? null,
        row.chapter_id ?? null,
        row.subject_id ?? null,
        row.course_id ?? null,
        row.title,
        row.description,
      ]
    );
    return true;
  } catch (e) {
    console.error(`${TAG} ${label} ERROR:`, e.message);
    return false;
  }
}

router.post("/", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      console.log(`${TAG} ERROR: No auth header`);
      return res.status(401).json({ error: "No auth header" });
    }
    let studentId;
    try {
      studentId = jwt.verify(String(authHeader).replace(/^Bearer\s+/i, "").trim(), process.env.JWT_SECRET).sub;
      if (!studentId) throw new Error("no sub");
    } catch {
      console.log(`${TAG} AUTH ERROR`);
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { topicId, chapterId, subjectId, courseId, topicTitle } = req.body || {};
    const badges = [];

    console.log(`${TAG} START | studentId=${studentId} | topicId=${topicId} | chapterId=${chapterId} | subjectId=${subjectId} | courseId=${courseId}`);

    // 1. BRONZE: one per topic completed
    if (topicId) {
      const exists = await badgeExists(studentId, "bronze", { topic_id: topicId });
      if (!exists) {
        const ok = await insertBadge("BRONZE", {
          student_id: studentId,
          badge_type: "bronze",
          topic_id: topicId,
          chapter_id: chapterId || null,
          title: `Topic Completed: ${topicTitle || "Unknown"}`,
          description: "Earned by watching the full lecture video",
        });
        if (ok) badges.push("bronze");
      }
    }

    // 2. SILVER: every topic in the chapter has a bronze badge
    if (chapterId) {
      const { rows: chapterTopics } = await query("SELECT id FROM public.subject_topics WHERE chapter_id = $1", [chapterId]);
      const topicCount = chapterTopics.length;
      if (topicCount > 0) {
        const { rows: bronze } = await query(
          `SELECT topic_id FROM public.student_badges
            WHERE student_id = $1 AND badge_type = 'bronze' AND topic_id = ANY($2::uuid[])`,
          [studentId, chapterTopics.map((t) => t.id)]
        );
        if (bronze.length >= topicCount) {
          const exists = await badgeExists(studentId, "silver", { chapter_id: chapterId });
          if (!exists) {
            const { rows: chapterRows } = await query("SELECT title FROM public.subject_chapters WHERE id = $1", [chapterId]);
            const ok = await insertBadge("SILVER", {
              student_id: studentId,
              badge_type: "silver",
              chapter_id: chapterId,
              subject_id: subjectId || null,
              course_id: courseId || null,
              title: `Chapter Completed: ${chapterRows[0]?.title || "Unknown"}`,
              description: "Earned by completing all topics in this chapter",
            });
            if (ok) badges.push("silver");
          }
        }
      }
    }

    // 3. GOLD (3+ chapters) and MASTER (all chapters) in the subject
    if (subjectId) {
      const { rows: subjectChapters } = await query("SELECT id FROM public.subject_chapters WHERE subject_id = $1", [subjectId]);
      const chapterCount = subjectChapters.length;
      if (chapterCount > 0) {
        const { rows: silver } = await query(
          `SELECT chapter_id FROM public.student_badges
            WHERE student_id = $1 AND badge_type = 'silver' AND chapter_id = ANY($2::uuid[])`,
          [studentId, subjectChapters.map((c) => c.id)]
        );
        const silverCount = silver.length;
        const subjectName = async () => {
          const { rows } = await query("SELECT name FROM public.popular_subjects WHERE id = $1", [subjectId]);
          return rows[0]?.name || "Unknown";
        };

        if (silverCount >= 3 && !(await badgeExists(studentId, "gold", { subject_id: subjectId }))) {
          const ok = await insertBadge("GOLD", {
            student_id: studentId,
            badge_type: "gold",
            subject_id: subjectId,
            course_id: courseId || null,
            title: `Gold Achievement: ${await subjectName()}`,
            description: "Earned by completing 3 chapters in this subject",
          });
          if (ok) badges.push("gold");
        }

        if (silverCount >= chapterCount && !(await badgeExists(studentId, "master", { subject_id: subjectId }))) {
          const ok = await insertBadge("MASTER", {
            student_id: studentId,
            badge_type: "master",
            subject_id: subjectId,
            course_id: courseId || null,
            title: `Subject Mastered: ${await subjectName()}`,
            description: "Earned by completing all chapters in this subject",
          });
          if (ok) badges.push("master");
        }
      }
    }

    // 4. COURSE COMPLETE: every subject in the course is mastered
    if (courseId) {
      const { rows: courseSubjects } = await query("SELECT subject_id FROM public.course_subjects WHERE course_id = $1", [courseId]);
      const subjectCount = courseSubjects.length;
      if (subjectCount > 0) {
        const { rows: master } = await query(
          `SELECT subject_id FROM public.student_badges
            WHERE student_id = $1 AND badge_type = 'master' AND subject_id = ANY($2::uuid[])`,
          [studentId, courseSubjects.map((s) => s.subject_id)]
        );
        if (master.length >= subjectCount) {
          const exists = await badgeExists(studentId, "course_complete", { course_id: courseId });
          if (!exists) {
            const { rows: courseRows } = await query("SELECT name FROM public.courses WHERE id = $1", [courseId]);
            const ok = await insertBadge("COURSE_COMPLETE", {
              student_id: studentId,
              badge_type: "course_complete",
              course_id: courseId,
              title: `Course Completed: ${courseRows[0]?.name || "Unknown"}`,
              description: "Earned by mastering all subjects in this course",
            });
            if (ok) badges.push("course_complete");
          }
        }
      }
    }

    console.log(`${TAG} DONE | badges_awarded=${JSON.stringify(badges)}`);
    return res.json({ success: true, badges_awarded: badges });
  } catch (err) {
    console.error(`${TAG} FATAL ERROR:`, err?.message);
    return res.status(500).json({ error: err?.message });
  }
});
