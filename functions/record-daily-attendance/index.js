// Port of supabase/functions/record-daily-attendance.
// Records that the signed-in student was active today (one row per student per UTC day) and
// returns their streak and monthly attendance figures.
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";

export const router = express.Router();

const isoDate = (d) => d.toISOString().split("T")[0];

// Same calculation as the original, including its UTC date handling.
async function calculateAttendanceStats(studentId) {
  const now = new Date();
  const thirtyDaysAgo = isoDate(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));

  let records;
  try {
    const { rows } = await query(
      `SELECT attendance_date::text AS attendance_date FROM public.daily_login_attendance
        WHERE student_id = $1 AND attendance_date >= $2::date
        ORDER BY attendance_date DESC`,
      [studentId, thirtyDaysAgo]
    );
    records = rows;
  } catch (error) {
    console.error("[Attendance Stats] Error fetching records:", error.message);
    return {
      current_streak: 0,
      monthly_attendance_percentage: 0,
      days_present_this_month: 0,
      total_days_this_month: now.getDate(),
      last_7_days: [],
    };
  }

  const attendedDates = new Set(records.map((r) => r.attendance_date));

  // Current streak: consecutive days including today.
  let streak = 0;
  const checkDate = new Date(now);
  while (attendedDates.has(isoDate(checkDate))) {
    streak++;
    checkDate.setDate(checkDate.getDate() - 1);
  }

  // Days present so far this month.
  const daysInMonthSoFar = now.getDate();
  let daysPresent = 0;
  for (let i = 1; i <= daysInMonthSoFar; i++) {
    if (attendedDates.has(isoDate(new Date(now.getFullYear(), now.getMonth(), i)))) daysPresent++;
  }
  const monthlyPercentage = daysInMonthSoFar > 0 ? Math.round((daysPresent / daysInMonthSoFar) * 100) : 0;

  const last7Days = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = isoDate(date);
    last7Days.push({ date: dateStr, present: attendedDates.has(dateStr) });
  }

  return {
    current_streak: streak,
    monthly_attendance_percentage: monthlyPercentage,
    days_present_this_month: daysPresent,
    total_days_this_month: daysInMonthSoFar,
    last_7_days: last7Days,
  };
}

router.all("/", async (req, res) => {
  const json = (status, body) => res.status(status).json(body);
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return json(401, { error: "No authorization header" });

    let payload;
    try {
      payload = jwt.verify(authHeader.replace(/^Bearer\s+/i, ""), process.env.JWT_SECRET);
    } catch {
      return json(401, { error: "Unauthorized" });
    }
    const studentId = payload.sub;
    if (!studentId) return json(401, { error: "Unauthorized" });

    const deviceType = req.query.device_type || "web";
    const today = isoDate(new Date());

    const { rows: existingRows } = await query(
      `SELECT id, login_count, first_login_at FROM public.daily_login_attendance
        WHERE student_id = $1 AND attendance_date = $2::date LIMIT 1`,
      [studentId, today]
    );
    const existing = existingRows[0];

    let todayRecord;
    if (existing) {
      const { rows } = await query(
        `UPDATE public.daily_login_attendance
            SET last_active_at = now(), login_count = $2
          WHERE id = $1
          RETURNING first_login_at, login_count`,
        [existing.id, (existing.login_count || 1) + 1]
      );
      todayRecord = rows[0];
      console.log(`[Attendance] Updated for ${studentId}, login_count: ${todayRecord.login_count}`);
    } else {
      const { rows } = await query(
        `INSERT INTO public.daily_login_attendance
           (student_id, attendance_date, device_type, first_login_at, last_active_at, login_count)
         VALUES ($1, $2::date, $3, now(), now(), 1)
         RETURNING first_login_at, login_count`,
        [studentId, today, deviceType]
      );
      todayRecord = rows[0];
      console.log(`[Attendance] New record created for ${studentId}`);
    }

    const stats = await calculateAttendanceStats(studentId);
    return json(200, {
      success: true,
      today: {
        marked: true,
        first_login_at: todayRecord.first_login_at,
        login_count: todayRecord.login_count,
      },
      stats,
    });
  } catch (error) {
    console.error("[Attendance] Error:", error?.message);
    const message = error instanceof Error ? error.message : "Internal server error";
    return json(500, { error: message });
  }
});

export default router;
