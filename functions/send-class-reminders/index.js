// Port of supabase/functions/send-class-reminders.
// Cron job, run every few minutes: finds timetable entries starting 15 to 17 minutes from now and,
// for each course, records a "class starting soon" notice per active push token of enrolled students.
//
// Authorisation: `Authorization: Bearer <CRON_SECRET>`. (The original had no check.)
//
// Carried over from the original, unchanged: it writes one notice per push token, and the actual
// push delivery is still a TODO (FCM/APNS). The notice rows are the only output.
import express from "express";
import { query } from "../_shared/db.js";

export const router = express.Router();

const hhmm = (d) => d.toTimeString().slice(0, 5);

router.all("/", async (req, res) => {
  const json = (status, body) => res.status(status).json(body);
  if (req.method === "OPTIONS") return res.status(200).end();

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return json(500, { error: "CRON_SECRET is not configured" });
  if (req.headers.authorization !== `Bearer ${cronSecret}`) return json(401, { error: "Unauthorized" });

  try {
    const now = new Date();
    const currentDayOfWeek = now.getDay(); // 0 = Sunday
    const targetTimeStr = hhmm(new Date(now.getTime() + 15 * 60 * 1000));
    const endWindowStr = hhmm(new Date(now.getTime() + 17 * 60 * 1000));
    console.log(`Checking for classes starting between ${targetTimeStr} and ${endWindowStr} on day ${currentDayOfWeek}`);

    const { rows: upcoming } = await query(
      `SELECT ct.id, ct.course_id, ct.subject_id, ct.instructor_id, ct.day_of_week, ct.start_time, ct.end_time,
              ct.meeting_link,
              ps.name AS subject_name,
              tp.full_name AS instructor_name,
              c.name AS course_name
         FROM public.course_timetables ct
         LEFT JOIN public.popular_subjects ps ON ps.id = ct.subject_id
         LEFT JOIN public.teacher_profiles tp ON tp.id = ct.instructor_id
         LEFT JOIN public.courses c ON c.id = ct.course_id
        WHERE ct.is_active = true
          AND ct.day_of_week = $1
          AND ct.start_time >= $2::time
          AND ct.start_time <= $3::time`,
      [currentDayOfWeek, targetTimeStr, endWindowStr]
    );

    if (upcoming.length === 0) {
      console.log("No classes starting in the next 15-17 minutes");
      return json(200, { message: "No upcoming classes to notify", notificationsSent: 0 });
    }
    console.log(`Found ${upcoming.length} classes starting soon`);

    let totalNotificationsSent = 0;
    for (const entry of upcoming) {
      let tokens;
      try {
        const { rows: enrolled } = await query(
          "SELECT student_id FROM public.enrollments WHERE course_id = $1 AND is_active = true",
          [entry.course_id]
        );
        if (enrolled.length === 0) {
          console.log(`No enrolled students for course ${entry.course_id}`);
          continue;
        }
        const { rows } = await query(
          `SELECT token, platform, user_id FROM public.push_notification_tokens
            WHERE user_id = ANY($1::uuid[]) AND is_active = true`,
          [enrolled.map((e) => e.student_id)]
        );
        tokens = rows;
      } catch (err) {
        console.error("Error fetching enrolment or push tokens:", err.message);
        continue;
      }
      if (tokens.length === 0) {
        console.log(`No push tokens found for students in course ${entry.course_id}`);
        continue;
      }

      const subjectName = entry.subject_name || "Class";
      const instructorName = entry.instructor_name || "Instructor";
      const title = "📚 Class Starting Soon!";
      const description = `${subjectName} with ${instructorName} starts in 15 minutes`;

      for (const t of tokens) {
        try {
          console.log(`Sending notification to ${t.platform} device: ${title}`);
          await query(
            `INSERT INTO public.notices (title, description, category, priority, is_global, created_by)
             VALUES ($1, $2, 'class_reminder', 'high', false, NULL)`,
            [title, description]
          );
          totalNotificationsSent++;
        } catch (sendError) {
          console.error("Error sending notification:", sendError.message);
        }
      }
    }

    console.log(`Total notifications sent: ${totalNotificationsSent}`);
    return json(200, {
      message: "Class reminders processed",
      classesFound: upcoming.length,
      notificationsSent: totalNotificationsSent,
    });
  } catch (error) {
    console.error("Error in send-class-reminders:", error?.message);
    return json(500, { error: error instanceof Error ? error.message : "Unknown error" });
  }
});

export default router;
