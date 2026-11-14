// Student dashboard, one endpoint per part of the screen. Each returns only the fields the screen shows.
// All routes need a signed-in student (Bearer JWT, sub = student id) and use parameterised SQL only.
//
//   GET /functions/v1/dashboard/profile                 user, is_checker, enrolled_sslc
//   GET /functions/v1/dashboard/notices-count           unread_notice_count
//   GET /functions/v1/dashboard/dpp?tz=                 streak, average_score, today_completed, week
//   GET /functions/v1/dashboard/attendance              percentage, last_7_days
//   GET /functions/v1/dashboard/courses?course_id=&tz=  courses with subjects and progress
//   GET /functions/v1/dashboard/study-plan?tz=&course_id=  yesterday, today, tomorrow sessions
//   GET /functions/v1/dashboard/upcoming-classes?limit= upcoming live classes
//
// tz is an IANA zone (default Asia/Kolkata) used for "today" and day boundaries.
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";

export const router = express.Router();

// The SSLC course that the dashboard promotes (same id the frontend uses).
const SSLC_COURSE_ID = "4c10bc8e-acbc-4b76-b7f5-54376c030cb0";
const DEFAULT_TZ = "Asia/Kolkata";

// Returns the student id from the Bearer token, or null.
function studentIdOf(req) {
  const header = req.headers.authorization || "";
  if (!header) return null;
  try {
    const payload = jwt.verify(header.replace(/^Bearer\s+/i, ""), process.env.JWT_SECRET);
    return payload.sub || null;
  } catch {
    return null;
  }
}

// Wraps a handler: 401 without a valid token, 500 with a JSON error if the handler throws.
function route(handler) {
  return async (req, res) => {
    const studentId = studentIdOf(req);
    if (!studentId) return res.status(401).json({ error: "Unauthorized" });
    try {
      return await handler(req, res, studentId);
    } catch (error) {
      console.error("[dashboard]", req.path, error.message);
      return res.status(500).json({ error: "Dashboard query failed" });
    }
  };
}

// A valid IANA zone, or the default.
function zoneOf(raw) {
  if (typeof raw !== "string" || !raw) return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: raw });
    return raw;
  } catch {
    return DEFAULT_TZ;
  }
}

// "YYYY-MM-DD" for a Date in the given zone.
const dateInZone = (date, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

// Adds n days to a "YYYY-MM-DD" string (calendar arithmetic, no zone).
function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// The UTC instant at which a zone's calendar day starts (for "yesterday 00:00 in tz" etc.).
function zoneMidnightUtc(ymd, tz) {
  // Guess UTC midnight, then correct by the zone's offset at that moment.
  const guess = new Date(`${ymd}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(guess);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asIfUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return new Date(guess.getTime() - (asIfUtc - guess.getTime()));
}

// ---------- profile ----------
router.get("/profile", route(async (req, res, studentId) => {
  const [{ rows: userRows }, { rows: roleRows }, { rows: sslcRows }] = await Promise.all([
    query("SELECT id, full_name, avatar_url, email FROM public.profiles WHERE id = $1", [studentId]),
    query("SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id = $1 AND role = 'checker') AS is_checker", [studentId]),
    query("SELECT EXISTS(SELECT 1 FROM public.enrollments WHERE student_id = $1 AND is_active AND course_id = $2) AS enrolled", [studentId, SSLC_COURSE_ID]),
  ]);
  const p = userRows[0] || {};
  return res.json({
    user: { id: studentId, full_name: p.full_name || null, avatar_url: p.avatar_url || null, email: p.email || null },
    is_checker: roleRows[0].is_checker,
    enrolled_sslc: sslcRows[0].enrolled,
  });
}));

// ---------- notices ----------
router.get("/notices-count", route(async (req, res, studentId) => {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM public.notices n
      WHERE n.is_active AND NOT EXISTS (SELECT 1 FROM public.notice_reads r WHERE r.notice_id = n.id AND r.user_id = $1)`,
    [studentId]
  );
  return res.json({ unread_notice_count: rows[0].n });
}));

// ---------- DPP (daily practice test) ----------
router.get("/dpp", route(async (req, res, studentId) => {
  const tz = zoneOf(req.query.tz);
  const today = dateInZone(new Date(), tz);
  const { rows: dayRows } = await query(
    `SELECT DISTINCT test_date::text AS d FROM public.dpp_topic_submissions
      WHERE student_id = $1 AND test_date >= ($2::date - 400)`,
    [studentId, today]
  );
  const days = new Set(dayRows.map((r) => r.d));

  // Streak: consecutive days with a submission, counting back from today.
  let streak = 0;
  for (let day = today; days.has(day); day = addDays(day, -1)) streak++;

  const { rows: avgRows } = await query(
    `SELECT round(avg(CASE WHEN total_questions > 0 THEN score::numeric / total_questions * 100 ELSE 0 END))::int AS avg
       FROM public.dpp_topic_submissions WHERE student_id = $1`,
    [studentId]
  );

  const { rows: weekRows } = await query(
    `SELECT test_date::text AS d, max(score)::int AS score FROM public.dpp_topic_submissions
      WHERE student_id = $1 AND test_date >= ($2::date - 6) AND test_date <= $2::date
      GROUP BY test_date`,
    [studentId, today]
  );
  const scoreByDay = new Map(weekRows.map((r) => [r.d, r.score]));
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const date = addDays(today, -i);
    const dayName = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(new Date(`${date}T00:00:00Z`));
    week.push({ date, day: dayName, completed: scoreByDay.has(date), score: scoreByDay.get(date) || 0 });
  }

  const { rows: totalRows } = await query("SELECT count(*)::int AS n FROM public.dpp_topic_submissions WHERE student_id = $1", [studentId]);
  return res.json({
    streak,
    average_score: avgRows[0].avg || 0,
    today_completed: days.has(today),
    total_submissions: totalRows[0].n,
    week,
  });
}));

// ---------- attendance ----------
router.get("/attendance", route(async (req, res, studentId) => {
  const now = new Date();
  const isoDate = (d) => d.toISOString().split("T")[0];
  const thirtyDaysAgo = isoDate(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));
  const { rows } = await query(
    `SELECT attendance_date::text AS d FROM public.daily_login_attendance
      WHERE student_id = $1 AND attendance_date >= $2::date`,
    [studentId, thirtyDaysAgo]
  );
  const attended = new Set(rows.map((r) => r.d));
  const daysSoFar = now.getDate();
  let present = 0;
  for (let i = 1; i <= daysSoFar; i++) {
    if (attended.has(isoDate(new Date(now.getFullYear(), now.getMonth(), i)))) present++;
  }
  const last7 = [];
  for (let i = 0; i < 7; i++) {
    const d = isoDate(new Date(now.getTime() - i * 24 * 60 * 60 * 1000));
    last7.push({ date: d, present: attended.has(d) });
  }
  return res.json({
    percentage: daysSoFar > 0 ? Math.round((present / daysSoFar) * 100) : 0,
    days_present_this_month: present,
    total_days_this_month: daysSoFar,
    last_7_days: last7,
  });
}));

// ---------- courses and subject progress ----------
// The student's enrolled courses (optionally one course), with each subject's chapter count, pending
// assignments and the five content counters. Overall % averages the counters that have a total > 0.
router.get("/courses", route(async (req, res, studentId) => {
  const courseId = req.query.course_id || null;
  const { rows: subjectRows } = await query(
    `WITH enrolled AS (
       SELECT course_id FROM public.enrollments
        WHERE student_id = $1 AND is_active AND ($2::uuid IS NULL OR course_id = $2::uuid))
     SELECT c.id AS course_id, c.name AS course_name, c.slug AS course_slug, c.thumbnail_url AS course_thumbnail,
            ps.id AS subject_id, ps.name AS subject_name, ps.thumbnail_url AS subject_thumbnail, cs.display_order
       FROM enrolled e
       JOIN public.courses c ON c.id = e.course_id
       JOIN public.course_subjects cs ON cs.course_id = c.id
       JOIN public.popular_subjects ps ON ps.id = cs.subject_id
      ORDER BY c.sequence_order NULLS LAST, c.name, cs.display_order`,
    [studentId, courseId]
  );
  if (subjectRows.length === 0) return res.json({ courses: [] });

  const subjectIds = [...new Set(subjectRows.map((r) => r.subject_id))];
  const courseIds = [...new Set(subjectRows.map((r) => r.course_id))];

  const [chapters, topics, jobs, topicVideos, watched, dppRows, paperRows, testRows, assignRows] = await Promise.all([
    query(
      `SELECT id, subject_id,
              (video_id IS NOT NULL AND video_platform IS NOT NULL) AS has_video,
              (ai_generated_video_url IS NOT NULL) AS has_ai_url,
              (ai_presentation_json IS NOT NULL) AS has_pres
         FROM public.subject_chapters WHERE subject_id = ANY($1::uuid[])`,
      [subjectIds]
    ),
    query(
      `SELECT t.id, t.chapter_id, c.subject_id,
              (t.video_id IS NOT NULL AND t.video_platform IS NOT NULL) AS has_video,
              (t.ai_generated_video_url IS NOT NULL) AS has_ai_url,
              (t.ai_presentation_json IS NOT NULL) AS has_pres
         FROM public.subject_topics t JOIN public.subject_chapters c ON c.id = t.chapter_id
        WHERE c.subject_id = ANY($1::uuid[])`,
      [subjectIds]
    ),
    query(
      `SELECT d.topic_id, d.chapter_id, d.subject_id, count(*)::int AS n
         FROM public.video_generation_jobs j JOIN public.ai_assistant_documents d ON d.id = j.document_id
        WHERE j.is_published AND j.status = 'completed' AND d.subject_id = ANY($1::uuid[])
        GROUP BY d.topic_id, d.chapter_id, d.subject_id`,
      [subjectIds]
    ),
    query(
      `SELECT tv.topic_id, count(*)::int AS n
         FROM public.topic_videos tv
         JOIN public.subject_topics t ON t.id = tv.topic_id
         JOIN public.subject_chapters c ON c.id = t.chapter_id
        WHERE tv.is_active AND c.subject_id = ANY($1::uuid[])
        GROUP BY tv.topic_id`,
      [subjectIds]
    ),
    query(
      `SELECT subject_id, count(DISTINCT video_title)::int AS n
         FROM public.ai_video_watch_logs
        WHERE student_id = $1 AND completion_percentage >= 80 AND subject_id = ANY($2::uuid[])
        GROUP BY subject_id`,
      [studentId, subjectIds]
    ),
    query(
      `SELECT q.subject_id, count(DISTINCT q.topic_id)::int AS total,
              count(DISTINCT q.topic_id) FILTER (WHERE q.topic_id IN
                 (SELECT topic_id FROM public.dpp_topic_submissions WHERE student_id = $1))::int AS solved
         FROM public.dpp_questions q
        WHERE q.is_active AND q.subject_id = ANY($2::uuid[])
        GROUP BY q.subject_id`,
      [studentId, subjectIds]
    ),
    query(
      `SELECT p.subject_id, p.paper_category, count(*)::int AS total,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.paper_test_results r
                                              WHERE r.paper_id = p.id AND r.student_id = $1))::int AS solved
         FROM public.subject_previous_year_papers p
        WHERE p.subject_id = ANY($2::uuid[]) AND p.paper_category IN ('previous_year', 'proficiency')
        GROUP BY p.subject_id, p.paper_category`,
      [studentId, subjectIds]
    ),
    query(
      `SELECT t.subject_id, count(*)::int AS total,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.test_results r
                                              WHERE r.test_id = t.id AND r.student_id = $1))::int AS solved
         FROM public.tests t
        WHERE t.test_type = 'practice' AND t.is_active AND t.subject_id = ANY($2::uuid[])
          AND t.title NOT ILIKE '%dpp%'
        GROUP BY t.subject_id`,
      [studentId, subjectIds]
    ),
    query(
      `SELECT a.id, a.chapter_id,
              EXISTS (SELECT 1 FROM public.assignment_submissions s WHERE s.assignment_id = a.id AND s.student_id = $1) AS submitted
         FROM public.assignments a
        WHERE a.is_active AND a.chapter_id IS NOT NULL AND a.course_id = ANY($2::uuid[])`,
      [studentId, courseIds]
    ),
  ]);

  // Index everything by subject / chapter / topic.
  const chaptersBySubject = new Map();
  const chapterById = new Map();
  for (const c of chapters.rows) {
    if (!chaptersBySubject.has(c.subject_id)) chaptersBySubject.set(c.subject_id, []);
    chaptersBySubject.get(c.subject_id).push(c.id);
    chapterById.set(c.id, c);
  }
  const topicsByChapter = new Map();
  for (const t of topics.rows) {
    if (!topicsByChapter.has(t.chapter_id)) topicsByChapter.set(t.chapter_id, []);
    topicsByChapter.get(t.chapter_id).push(t);
  }
  const jobsByChapter = new Map(); // published jobs whose document has no topic
  const jobsByTopic = new Map();
  for (const j of jobs.rows) {
    if (j.topic_id) jobsByTopic.set(j.topic_id, (jobsByTopic.get(j.topic_id) || 0) + j.n);
    else if (j.chapter_id) jobsByChapter.set(j.chapter_id, (jobsByChapter.get(j.chapter_id) || 0) + j.n);
  }
  const videosByTopic = new Map(topicVideos.rows.map((r) => [r.topic_id, r.n]));
  const watchedBySubject = new Map(watched.rows.map((r) => [r.subject_id, r.n]));
  const dppBySubject = new Map(dppRows.rows.map((r) => [r.subject_id, r]));
  const paperBySubjectCat = new Map(paperRows.rows.map((r) => [`${r.subject_id}|${r.paper_category}`, r]));
  const testsBySubject = new Map(testRows.rows.map((r) => [r.subject_id, r]));
  const assignBySubjectChapters = assignRows.rows; // filtered per subject below

  // Lecture total, same rules as the previous client code: a published AI job wins over the legacy AI
  // field, and a regular video (video_id + platform) always adds one.
  const lectureTotal = (subjectId) => {
    let total = 0;
    for (const chapterId of chaptersBySubject.get(subjectId) || []) {
      const ch = chapterById.get(chapterId);
      const jobsCount = jobsByChapter.get(chapterId) || 0;
      if (jobsCount > 0) total += jobsCount;
      else if (ch.has_ai_url || ch.has_pres) total += 1;
      if (ch.has_video) total += 1;
      for (const t of topicsByChapter.get(chapterId) || []) {
        const tc = jobsByTopic.get(t.id) || 0;
        if (tc > 0) total += tc;
        else if (t.has_ai_url || t.has_pres) total += 1;
        if (t.has_video) total += 1;
        total += videosByTopic.get(t.id) || 0;
      }
    }
    return total;
  };

  const pct = (done, total) => (total > 0 ? (done / total) * 100 : null);
  const overall = (parts) => {
    const values = parts.map((p) => pct(p.done, p.total)).filter((v) => v !== null);
    return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
  };

  const coursesOut = new Map();
  for (const row of subjectRows) {
    if (!coursesOut.has(row.course_id)) {
      coursesOut.set(row.course_id, {
        id: row.course_id, name: row.course_name, slug: row.course_slug, thumbnail_url: row.course_thumbnail, subjects: [],
      });
    }
    const sid = row.subject_id;
    const chapterIds = chaptersBySubject.get(sid) || [];
    const chapterSet = new Set(chapterIds);
    const pendingAssignments = assignBySubjectChapters.filter(
      (a) => chapterSet.has(a.chapter_id) && !a.submitted
    ).length;

    const total = lectureTotal(sid);
    const watchedCount = Math.min(watchedBySubject.get(sid) || 0, total);
    const dpp = dppBySubject.get(sid) || { total: 0, solved: 0 };
    const pyq = paperBySubjectCat.get(`${sid}|previous_year`) || { total: 0, solved: 0 };
    const prof = paperBySubjectCat.get(`${sid}|proficiency`) || { total: 0, solved: 0 };
    const tests = testsBySubject.get(sid) || { total: 0, solved: 0 };

    const progress = {
      lectures: { total, done: watchedCount },
      dpp: { total: dpp.total, done: dpp.solved },
      pyq: { total: pyq.total, done: pyq.solved },
      proficiency: { total: prof.total, done: prof.solved },
      tests: { total: tests.total, done: tests.solved },
    };

    coursesOut.get(row.course_id).subjects.push({
      id: sid,
      name: row.subject_name,
      thumbnail_url: row.subject_thumbnail,
      chapters_total: chapterIds.length,
      pending_assignments: pendingAssignments,
      overall_percentage: overall(Object.values(progress)),
      progress,
    });
  }

  return res.json({ courses: [...coursesOut.values()] });
}));

// ---------- study plan (yesterday, today, tomorrow) ----------
router.get("/study-plan", route(async (req, res, studentId) => {
  const tz = zoneOf(req.query.tz);
  const courseId = req.query.course_id || null;
  const today = dateInZone(new Date(), tz);
  const from = zoneMidnightUtc(addDays(today, -1), tz);
  const to = zoneMidnightUtc(addDays(today, 2), tz);

  const { rows } = await query(
    `SELECT s.id, s.course_id, c.name AS course_name, s.subject_id, ps.name AS subject_name,
            s.chapter_id, ch.title AS chapter_title, s.topic_id, t.title AS topic_title,
            s.title, s.scheduled_at, s.duration_minutes, s.status
       FROM public.study_timetable_sessions s
       JOIN public.courses c ON c.id = s.course_id
       JOIN public.enrollments e ON e.course_id = s.course_id AND e.student_id = $1 AND e.is_active
       LEFT JOIN public.popular_subjects ps ON ps.id = s.subject_id
       LEFT JOIN public.subject_chapters ch ON ch.id = s.chapter_id
       LEFT JOIN public.subject_topics t ON t.id = s.topic_id
      WHERE s.student_id = $1 AND s.scheduled_at >= $2 AND s.scheduled_at < $3
        AND ($4::uuid IS NULL OR s.course_id = $4::uuid)
      ORDER BY s.scheduled_at`,
    [studentId, from, to, courseId]
  );

  const out = { yesterday: [], today: [], tomorrow: [] };
  const names = { [addDays(today, -1)]: "yesterday", [today]: "today", [addDays(today, 1)]: "tomorrow" };
  for (const row of rows) {
    const key = names[dateInZone(new Date(row.scheduled_at), tz)];
    if (key) out[key].push(row);
  }
  const { rows: enr } = await query("SELECT EXISTS(SELECT 1 FROM public.enrollments WHERE student_id = $1 AND is_active) AS has", [studentId]);
  return res.json({ ...out, has_enrollment: enr[0].has, today_date: today, timezone: tz });
}));

// ---------- upcoming live classes ----------
router.get("/upcoming-classes", route(async (req, res, studentId) => {
  const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 5));
  const { rows } = await query(
    `SELECT DISTINCT ON (sc.id) sc.id, sc.subject, ps.name AS subject_name, c.name AS course_name, sc.notes,
            sc.scheduled_at, sc.duration_minutes, sc.meeting_link, COALESCE(sc.is_live, false) AS is_live,
            tp.id AS teacher_id, tp.full_name AS teacher_name, tp.avatar_url AS teacher_avatar
       FROM public.scheduled_classes sc
       JOIN public.enrollments e ON e.course_id = sc.course_id AND e.student_id = $1 AND e.is_active
       JOIN public.courses c ON c.id = sc.course_id
       LEFT JOIN public.popular_subjects ps ON ps.id = sc.subject_id
       LEFT JOIN public.teacher_profiles tp ON tp.id = sc.teacher_id
      WHERE sc.scheduled_at >= now() AND NOT sc.is_cancelled
      ORDER BY sc.id, sc.scheduled_at
      LIMIT $2`,
    [studentId, limit]
  );
  // DISTINCT ON needs the id first in ORDER BY; re-sort by time for the screen.
  rows.sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
  return res.json({
    classes: rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      subject_name: r.subject_name || r.subject || null,
      course_name: r.course_name,
      notes: r.notes,
      scheduled_at: r.scheduled_at,
      duration_minutes: r.duration_minutes,
      meeting_link: r.meeting_link,
      is_live: r.is_live,
      teacher: r.teacher_id ? { id: r.teacher_id, full_name: r.teacher_name, avatar_url: r.teacher_avatar } : null,
    })),
  });
}));
