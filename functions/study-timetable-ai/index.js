// Port of supabase/functions/study-timetable-ai. Study planner for a signed-in student.
// POST { action, ... } with Authorization: Bearer <user JWT>. Actions:
//   evaluate_feasibility { scopeLabel, contentDurationMinutes, deadline, startDate?, dailyHours }
//       -> AI verdict { verdict, message } (calls the AI provider set in Admin Settings)
//   generate_plan { courseId, scopeLabel, scopeType, scopeId?, deadline, startDate?, weekday, saturday,
//                   sunday, items[], itemsOriginal?, feedbackMessage?, pattern?, tzOffsetMinutes? }
//       -> writes a study_timetables row and its study_timetable_sessions; returns { timetable_id, sessions_created }
// As in the original, every action first loads the AI config (ai_api_config), so AI must be enabled.
import express from "express";
import jwt from "jsonwebtoken";
import { query } from "../_shared/db.js";

export const router = express.Router();

const DAY_MS = 24 * 60 * 60 * 1000;

function intervalMinutes(iv) {
  const [sh, sm] = iv.start.split(":").map(Number);
  const [eh, em] = iv.end.split(":").map(Number);
  return Math.max(0, eh * 60 + em - (sh * 60 + sm));
}

function canonicalizeItemsBySubject(items) {
  const queues = new Map();
  const order = [];
  for (const item of items || []) {
    const key = item.subject_id || "__none__";
    if (!queues.has(key)) {
      queues.set(key, []);
      order.push(key);
    }
    queues.get(key).push(item);
  }
  return order.flatMap((key) => queues.get(key) || []);
}

// Loads the AI settings the same way the original did. Throws with a user-facing message.
async function loadAIConfig() {
  const { rows } = await query("SELECT setting_value FROM public.ai_settings WHERE setting_key = 'ai_api_config' LIMIT 1");
  const cfg = rows[0]?.setting_value || {};
  if (!cfg || cfg.enabled === false) {
    throw new Error("AI is disabled in Admin Settings. Enable it and add an API key.");
  }
  const provider = cfg.provider || "openrouter";
  if (provider === "openrouter") {
    if (!cfg.openrouter_api_key) throw new Error("OpenRouter API key missing in Admin Settings.");
    return {
      apiUrl: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: cfg.openrouter_api_key,
      model: cfg.default_model || "google/gemini-2.5-flash",
    };
  }
  if (provider === "openai") {
    if (!cfg.openai_api_key) throw new Error("OpenAI API key missing in Admin Settings.");
    return {
      apiUrl: "https://api.openai.com/v1/chat/completions",
      apiKey: cfg.openai_api_key,
      model: cfg.default_model || "gpt-4o-mini",
    };
  }
  if (!cfg.google_api_key) throw new Error("Google Gemini API key missing in Admin Settings.");
  return {
    apiUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    apiKey: cfg.google_api_key,
    model: cfg.default_model || "gemini-2.5-flash",
  };
}

async function callAI(cfg, system, user) {
  const res = await fetch(cfg.apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      temperature: 0.4,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    if (res.status === 401) throw new Error("Invalid API key in Admin Settings.");
    if (res.status === 429) throw new Error("AI quota/rate limit hit. Please try again later.");
    throw new Error(`AI error ${res.status}: ${txt}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "{}";
  try {
    return JSON.parse(content);
  } catch {
    const cleaned = content.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    return JSON.parse(cleaned);
  }
}

// The deterministic scheduler. Pure: `nowMs` is passed in so it can be tested.
// Returns { sessions: [{ item_id, title, scheduled_at, duration_minutes }], unscheduled, tzOffsetMinutes }.
export function buildPlan(b, nowMs = Date.now()) {
  // tzOffsetMinutes is the value of JS Date.getTimezoneOffset() in the browser (UTC - local): IST is -330.
  const TZ = typeof b.tzOffsetMinutes === "number" ? b.tzOffsetMinutes : 0;

  const planFor = (dow) => (dow === 0 ? b.sunday : dow === 6 ? b.saturday : b.weekday);
  const sortIntervals = (p) => [...(p?.intervals || [])].sort((a, c) => a.start.localeCompare(c.start));
  const toMin = (t) => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  };
  const fromMin = (n) => `${Math.floor(n / 60).toString().padStart(2, "0")}:${(n % 60).toString().padStart(2, "0")}`;
  const localToUtcIso = (y, mo, d, mins) => new Date(Date.UTC(y, mo, d, 0, 0, 0) + (mins + TZ) * 60000).toISOString();

  // "Today" in the student's local time.
  const nowLocal = new Date(nowMs - TZ * 60000);
  const nowLocalMinutes = nowLocal.getUTCHours() * 60 + nowLocal.getUTCMinutes();
  const todayY = nowLocal.getUTCFullYear();
  const todayM = nowLocal.getUTCMonth();
  const todayD = nowLocal.getUTCDate();
  const todayKey = todayY * 10000 + (todayM + 1) * 100 + todayD;

  // A start date is honoured only when it is after today.
  let cursorY = todayY;
  let cursorM = todayM;
  let cursorD = todayD;
  if (b.startDate) {
    const [sy, sm, sd] = b.startDate.split("-").map(Number);
    if (sy * 10000 + sm * 100 + sd > todayKey) {
      cursorY = sy;
      cursorM = sm - 1;
      cursorD = sd;
    }
  }

  const [dy, dm, dd] = b.deadline.split("-").map(Number);
  const deadlineKey = dy * 10000 + dm * 100 + dd;

  // Step 1: every (date, interval) slot from the start date to the deadline, inclusive.
  const slots = [];
  {
    let cy = cursorY;
    let cm = cursorM;
    let cd = cursorD;
    let safety = 800;
    while (safety-- > 0) {
      const normalized = new Date(Date.UTC(cy, cm, cd));
      cy = normalized.getUTCFullYear();
      cm = normalized.getUTCMonth();
      cd = normalized.getUTCDate();
      const key = cy * 10000 + (cm + 1) * 100 + cd;
      if (key > deadlineKey) break;
      let intervals = sortIntervals(planFor(normalized.getUTCDay()));
      if (key === todayKey) {
        // Today: clip intervals so nothing is scheduled in the past.
        intervals = intervals
          .map((iv) => {
            const startM = Math.max(toMin(iv.start), nowLocalMinutes);
            const endM = toMin(iv.end);
            if (startM >= endM) return null;
            return { ...iv, start: fromMin(startM) };
          })
          .filter((iv) => iv !== null);
      }
      slots.push({ y: cy, m: cm, d: cd, intervals });
      cd += 1;
    }
  }

  const totalCapacityMin = slots.reduce((sum, s) => sum + s.intervals.reduce((a, iv) => a + intervalMinutes(iv), 0), 0);
  const N = b.items.length;

  // Step 2: one length for every topic, capped by the longest interval so each topic fits.
  const maxIntervalMin = slots.reduce((max, s) => s.intervals.reduce((m, iv) => Math.max(m, intervalMinutes(iv)), max), 0);
  const idealPerTopic = N > 0 ? Math.floor(totalCapacityMin / N) : 0;
  const perTopicMin = N > 0 ? Math.max(5, Math.min(idealPerTopic || 5, maxIntervalMin || 5, 90)) : 0;

  const queue = b.items.map((i) => ({ id: i.id, title: i.title }));
  const sessions = [];

  if (perTopicMin > 0) {
    // Step 3: spread topics across the days with capacity, never overflowing an interval.
    for (let si = 0; si < slots.length && queue.length > 0; si++) {
      const slot = slots[si];
      if (slot.intervals.length === 0) continue;
      const remainingDays = slots.slice(si).filter((s) => s.intervals.length > 0).length;
      const target = Math.max(1, Math.ceil(queue.length / Math.max(1, remainingDays)));
      let placedToday = 0;
      for (const iv of slot.intervals) {
        let cur = toMin(iv.start);
        const ivEnd = toMin(iv.end);
        while (placedToday < target && cur + perTopicMin <= ivEnd && queue.length > 0) {
          const topic = queue.shift();
          sessions.push({
            item_id: topic.id,
            title: topic.title,
            scheduled_at: localToUtcIso(slot.y, slot.m, slot.d, cur),
            duration_minutes: perTopicMin,
          });
          cur += perTopicMin;
          placedToday += 1;
        }
        if (placedToday >= target || queue.length === 0) break;
      }
    }
  }

  return { sessions, unscheduled: queue.length, tzOffsetMinutes: TZ, perTopicMin };
}

async function insertSessions(rows) {
  const COLS = 9;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const params = [];
    const tuples = chunk.map((r, idx) => {
      const base = idx * COLS;
      params.push(
        r.timetable_id, r.student_id, r.course_id, r.subject_id, r.chapter_id,
        r.topic_id, r.title, r.scheduled_at, r.duration_minutes
      );
      return `(${Array.from({ length: COLS }, (_, k) => `$${base + k + 1}`).join(", ")})`;
    });
    await query(
      `INSERT INTO public.study_timetable_sessions
         (timetable_id, student_id, course_id, subject_id, chapter_id, topic_id, title, scheduled_at, duration_minutes)
       VALUES ${tuples.join(", ")}`,
      params
    );
  }
}

async function evaluateFeasibility(aiCfg, b) {
  const deadlineDate = new Date(b.deadline);
  const startMs = b.startDate ? new Date(b.startDate).getTime() : Date.now();
  const daysAvailable = Math.max(1, Math.ceil((deadlineDate.getTime() - startMs) / DAY_MS));
  const totalAvailableMinutes = daysAvailable * (b.dailyHours || 1) * 60;

  const system = `You are a study planning coach. Reply ONLY with JSON: {"verdict":"too_short"|"ok"|"generous","message":"..."}.
- "too_short": the time is too little to realistically finish.
- "ok": time is reasonable; reply with a short motivational message.
- "generous": plenty of time; encourage steady pace.
Keep messages friendly, 1-2 sentences, relatable.`;

  const userPrompt = `Scope: ${b.scopeLabel}
Content duration to study: ${b.contentDurationMinutes} minutes
Start date: ${b.startDate || "today"}
Deadline: ${b.deadline} (${daysAvailable} days from start)
User plans ${b.dailyHours} hours/day
Total study time available with this plan: ${totalAvailableMinutes} minutes
Decide verdict and write a motivating message.`;

  return callAI(aiCfg, system, userPrompt);
}

async function generatePlan(userId, b) {
  const plan = buildPlan(b, Date.now());
  const canonicalOriginalItems = canonicalizeItemsBySubject(
    b.itemsOriginal && b.itemsOriginal.length ? b.itemsOriginal : b.items
  );

  const { rows } = await query(
    `INSERT INTO public.study_timetables (student_id, course_id, mode, plan_metadata)
     VALUES ($1, $2, 'auto', $3::jsonb) RETURNING id`,
    [
      userId,
      b.courseId,
      JSON.stringify({
        scopeType: b.scopeType,
        scopeId: b.scopeId,
        scopeLabel: b.scopeLabel,
        deadline: b.deadline,
        startDate: b.startDate || null,
        weekday: b.weekday,
        saturday: b.saturday,
        sunday: b.sunday,
        tzOffsetMinutes: plan.tzOffsetMinutes,
        feedbackMessage: b.feedbackMessage,
        unscheduled_items: plan.unscheduled,
        pattern: b.pattern || "sequential",
        items: b.items,
        items_original: canonicalOriginalItems,
      }),
    ]
  );
  const timetableId = rows[0].id;

  const itemMap = new Map(b.items.map((i) => [i.id, i]));
  const sessionRows = plan.sessions.map((s) => {
    const item = itemMap.get(s.item_id);
    return {
      timetable_id: timetableId,
      student_id: userId,
      course_id: b.courseId,
      subject_id: item?.subject_id || null,
      chapter_id: item?.chapter_id || null,
      topic_id: item?.topic_id || null,
      title: s.title || item?.title || "Study session",
      scheduled_at: s.scheduled_at,
      duration_minutes: s.duration_minutes,
    };
  });
  await insertSessions(sessionRows);

  return { timetable_id: timetableId, sessions_created: sessionRows.length };
}

function signedInUser(req) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!req.headers.authorization) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET).sub || null;
  } catch {
    return null;
  }
}

router.post("/", async (req, res) => {
  try {
    const userId = signedInUser(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const body = req.body || {};
    const aiCfg = await loadAIConfig();

    if (body.action === "evaluate_feasibility") {
      const out = await evaluateFeasibility(aiCfg, body);
      return res.json(out);
    }

    if (body.action === "generate_plan") {
      return res.json(await generatePlan(userId, body));
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    console.error("[study-timetable-ai] error:", err?.message);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
});

export default router;
