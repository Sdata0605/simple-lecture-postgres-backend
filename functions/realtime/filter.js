// Table allowlist and filter parsing for the realtime change feed.
// Filters use the Supabase form "column=op.value", for example "student_id=eq.<uuid>" or "id=in.(a,b)".

export const REALTIME_TABLES = new Set([
  "auto_submission_runs",
  "cdn_presentation_refresh_runs",
  "forum_group_messages",
  "forum_groups",
  "gap_patcher_queue",
  "gap_patcher_settings",
  "kannada_queue_items",
  "presentation_update_runs",
  "scheduled_classes",
  "student_lecture_notes",
  "video_generation_jobs",
]);

const FILTER_RE = /^([a-zA-Z_][a-zA-Z0-9_]*)=(eq|neq|lt|lte|gt|gte|in)\.(.*)$/;

// Returns null for no filter; throws on a filter this server does not understand.
export function parseFilter(filter) {
  if (filter === undefined || filter === null || filter === "") return null;
  const m = FILTER_RE.exec(String(filter));
  if (!m) throw new Error(`unsupported filter: ${filter}`);
  const [, column, op, raw] = m;
  if (op === "in") {
    const inner = raw.replace(/^\(/, "").replace(/\)$/, "");
    return { column, op, values: inner.length ? inner.split(",") : [] };
  }
  return { column, op, value: raw };
}

// True when a row passes the parsed filter. A missing column never matches.
export function matchesFilter(row, parsed) {
  if (!parsed) return true;
  if (!row || !(parsed.column in row)) return false;
  const v = row[parsed.column];
  if (v === null || v === undefined) return false;
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  switch (parsed.op) {
    case "eq": return s === parsed.value;
    case "neq": return s !== parsed.value;
    case "in": return parsed.values.includes(s);
    case "lt": return compare(s, parsed.value) < 0;
    case "lte": return compare(s, parsed.value) <= 0;
    case "gt": return compare(s, parsed.value) > 0;
    case "gte": return compare(s, parsed.value) >= 0;
    default: return false;
  }
}

// Numeric comparison when both sides are numbers, otherwise string comparison.
function compare(a, b) {
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && a !== "" && b !== "") return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}
